/**
 * Human stream API — /api/human/*
 * H:H only. Refuses party:"ai" and any non-human claim (not_human).
 *
 * Seeded topic shelf: GET /topics lists root topic rooms (excludes welcome).
 * Branch: POST /rooms/:id/branch creates a child with parent_id.
 * Merge: POST /rooms/:id/merge { target_id } moves messages; sets merged_into.
 * Join/post/list/leave reuse rooms/:id/*.
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

function validateBody(body) {
  if (typeof body !== 'string') {
    throw protocolError('invalid_body');
  }
  const trimmed = body.trim();
  if (trimmed.length < 1 || body.length > 4000) {
    throw protocolError('invalid_body');
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
    const room = store.createRoom();
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
    const { handle: rawHandle, party, title } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);
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
    validateHandle(rawHandle);
    if (typeof targetId !== 'string' || !targetId.trim()) {
      throw protocolError('invalid_request', 'target_id is required.');
    }
    const target = requireRoom(targetId.trim());
    assertNotMerged(source);
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
    const body = validateBody(rawBody);
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
