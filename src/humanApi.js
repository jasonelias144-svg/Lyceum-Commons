/**
 * Human stream API — /api/human/*
 * H:H only. Refuses party:"ai" and any non-human claim (not_human).
 *
 * Seeded topic shelf: GET /topics lists root topic rooms (excludes welcome).
 * Branch: POST /rooms/:id/branch creates a child with parent_id.
 * Merge: POST /rooms/:id/merge { target_id } moves messages; sets merged_into.
 * Branch/merge require the actor on the parent/source (and merge target) roster.
 * Seeded roots and welcome cannot be merge sources; welcome cannot be a merge target.
 * Join/post/list/leave reuse rooms/:id/*.
 * Room format live|board sets post body caps (200 / 4000); fixed at create/seed.
 */
const express = require('express');
const store = require('./store');
const { protocolError, sendError } = require('./errors');

const router = express.Router();

const HANDLE_RE = /^[^\x00-\x1f\x7f]{1,40}$/;

function assertHumanParty(party) {
  if (party === undefined || party === null) {
    throw protocolError('invalid_request', 'party must be declared as "human".');
  }
  if (party !== 'human') {
    throw protocolError('not_human');
  }
}

function validateHandle(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || !handle.trim()) {
    throw protocolError('invalid_handle');
  }
  return handle.trim();
}

function validateBody(body, { format } = {}) {
  if (typeof body !== 'string') {
    throw protocolError('invalid_body');
  }
  const trimmed = body.trim();
  const fmt = store.normalizeFormat(format, store.FORMAT_BOARD);
  const max = store.bodyCapForFormat(fmt);
  if (trimmed.length < 1 || body.length > max) {
    const detail =
      fmt === store.FORMAT_LIVE
        ? 'Live rooms take up to 200 characters.'
        : 'Board rooms take up to 4000 characters.';
    throw protocolError('invalid_body', detail);
  }
  return body;
}

function requireRoom(id) {
  const room = store.getRoom(id);
  if (!room) throw protocolError('room_not_found');
  return room;
}

function roomMeta(room) {
  return {
    room_id: room.id,
    title: room.title || null,
    parent_id: room.parent_id ?? null,
    merged_into: room.merged_into ?? null,
    stream: room.stream,
    participants: room.participants,
    format: store.normalizeFormat(room.format, store.FORMAT_BOARD),
  };
}

function assertNotMerged(room) {
  if (room.merged_into) {
    throw protocolError(
      'room_merged',
      `This room was merged into ${room.merged_into}. Join that room instead.`
    );
  }
}

router.get('/topics', (_req, res) => {
  try {
    res.json({ topics: store.listTopics() });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms', (req, res) => {
  try {
    if (req.body && req.body.party !== undefined && req.body.party !== 'human') {
      throw protocolError('not_human');
    }
    let format = store.FORMAT_BOARD;
    if (req.body && req.body.format !== undefined) {
      if (req.body.format !== store.FORMAT_LIVE && req.body.format !== store.FORMAT_BOARD) {
        throw protocolError('invalid_request', 'format must be "live" or "board".');
      }
      format = req.body.format;
    }
    const room = store.createRoom({ format });
    res.status(201).json({
      ...roomMeta(room),
      created_at: room.created_at,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms/:id/branch', (req, res) => {
  try {
    const parent = requireRoom(req.params.id);
    assertNotMerged(parent);
    const { handle: rawHandle, party, title } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);
    if (!parent.roster.has(handle)) {
      throw protocolError('not_joined');
    }
    const room = store.branchRoom(parent, { title });
    room.roster.set(handle, { handle, joined_at: new Date().toISOString() });
    res.status(201).json({
      ...roomMeta(room),
      created_at: room.created_at,
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms/:id/merge', (req, res) => {
  try {
    const source = requireRoom(req.params.id);
    const { handle: rawHandle, party, target_id: targetId } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);
    if (typeof targetId !== 'string' || !targetId.trim()) {
      throw protocolError('invalid_request', 'target_id is required.');
    }
    const target = requireRoom(targetId.trim());
    assertNotMerged(source);
    store.assertMergeAllowed(source, target);
    if (!source.roster.has(handle)) {
      throw protocolError('not_joined');
    }
    if (!target.roster.has(handle)) {
      throw protocolError('not_joined');
    }
    const result = store.mergeRooms(source, target);
    res.json({
      ok: true,
      moved: result.moved,
      source: roomMeta(result.source),
      target: roomMeta(result.target),
    });
  } catch (err) {
    if (err.code && !err.status) {
      const mapped = protocolError(err.code);
      return sendError(res, mapped);
    }
    sendError(res, err);
  }
});

router.post('/rooms/:id/join', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    assertNotMerged(room);
    const { handle: rawHandle, party } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);

    if (room.roster.has(handle)) {
      return res.json({
        ...roomMeta(room),
        roster: store.listRoster(room),
      });
    }
    if (room.roster.size >= store.MAX_PARTIES) {
      throw protocolError('room_full');
    }
    room.roster.set(handle, { handle, joined_at: new Date().toISOString() });
    res.json({
      ...roomMeta(room),
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms/:id/post', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    assertNotMerged(room);
    const { handle: rawHandle, body: rawBody, party } = req.body || {};
    if (party !== undefined && party !== 'human') {
      throw protocolError('not_human');
    }
    const handle = validateHandle(rawHandle);
    if (!room.roster.has(handle)) {
      throw protocolError('not_joined');
    }
    const body = validateBody(rawBody, { format: room.format });
    const crypto = require('crypto');
    const message = {
      id: `msg_${crypto.randomBytes(6).toString('hex')}`,
      room_id: room.id,
      author: handle,
      party: 'human',
      body,
      created_at: new Date().toISOString(),
    };
    room.messages.push(message);
    res.status(201).json({ message });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/rooms/:id/messages', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const handle = req.query.handle;
    if (handle !== undefined) {
      if (!room.roster.has(String(handle))) {
        throw protocolError('not_joined');
      }
    }
    let messages = room.messages;
    const after = req.query.after;
    if (after) {
      const idx = messages.findIndex((m) => m.id === after);
      messages = idx >= 0 ? messages.slice(idx + 1) : messages;
    }
    res.json({
      ...roomMeta(room),
      messages,
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms/:id/leave', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const { handle: rawHandle, party } = req.body || {};
    if (party !== undefined && party !== 'human') {
      throw protocolError('not_human');
    }
    const handle = validateHandle(rawHandle);
    room.roster.delete(handle);
    res.json({
      ok: true,
      ...roomMeta(room),
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
