/**
 * Human stream API — /api/human/*
 * H:H only. Refuses party:"ai" and any non-human claim (not_human).
 */
const express = require('express');
const store = require('./store');
const { protocolError, sendError } = require('./errors');

const router = express.Router();

const HANDLE_RE = /^[^\x00-\x1f\x7f]{1,40}$/;

function assertHumanParty(party) {
  if (party === undefined || party === null) {
    // join requires explicit party declaration
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

/** POST /api/human/rooms → create */
router.post('/rooms', (req, res) => {
  try {
    // Refuse AI create attempts if someone sends party on create
    if (req.body && req.body.party !== undefined && req.body.party !== 'human') {
      throw protocolError('not_human');
    }
    const room = store.createRoom();
    res.status(201).json({
      room_id: room.id,
      stream: room.stream,
      participants: room.participants,
      created_at: room.created_at,
    });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/human/rooms/:id/join */
router.post('/rooms/:id/join', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const { handle: rawHandle, party } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);

    if (room.roster.has(handle)) {
      // idempotent re-join
      return res.json({ room_id: room.id, roster: store.listRoster(room) });
    }
    if (room.roster.size >= store.MAX_PARTIES) {
      throw protocolError('room_full');
    }
    room.roster.set(handle, { handle, joined_at: new Date().toISOString() });
    res.json({ room_id: room.id, roster: store.listRoster(room) });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/human/rooms/:id/post */
router.post('/rooms/:id/post', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const { handle: rawHandle, body: rawBody, party } = req.body || {};
    // Refuse AI posts even if somehow joined
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

/** GET /api/human/rooms/:id/messages — list (poll) */
router.get('/rooms/:id/messages', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    // Optional membership gate via ?handle= — if provided, must be joined
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
      room_id: room.id,
      stream: 'human',
      messages,
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/human/rooms/:id/leave */
router.post('/rooms/:id/leave', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const { handle: rawHandle, party } = req.body || {};
    if (party !== undefined && party !== 'human') {
      throw protocolError('not_human');
    }
    const handle = validateHandle(rawHandle);
    // leave if absent: no-op
    room.roster.delete(handle);
    res.json({ ok: true, room_id: room.id, roster: store.listRoster(room) });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
