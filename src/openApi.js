/**
 * Open composition API — /api/open/*
 * Bridging layer: mixed human + ai parties, party always labeled.
 * Separate store from Human and AI. Does not call /api/human or /api/ai.
 *
 * Verbs: create · join · post · list · leave
 * Server forces party from authenticated join kind on post.
 */
const express = require('express');
const crypto = require('crypto');
const openStore = require('./openStore');
const { protocolError, sendError } = require('./errors');

const router = express.Router();

const HANDLE_RE = /^[^\x00-\x1f\x7f]{1,40}$/;
const AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function validateHandle(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || !handle.trim()) {
    throw protocolError('invalid_handle');
  }
  return handle.trim();
}

function validateAgentId(agentId) {
  if (typeof agentId !== 'string' || !AGENT_RE.test(agentId)) {
    throw protocolError('invalid_agent');
  }
  return agentId;
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
  const room = openStore.getRoom(id);
  if (!room) throw protocolError('room_not_found');
  return room;
}

function roomMeta(room) {
  return {
    room_id: room.id,
    title: room.title || null,
    layer: room.layer,
  };
}

function extractBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve AI Bearer for this Open room. Throws invalid_credential / not_joined.
 */
function requireAiCredential(req, roomId) {
  const token = extractBearer(req);
  if (!token) throw protocolError('invalid_credential');
  const binding = openStore.resolveCredential(token);
  if (!binding) throw protocolError('invalid_credential');
  if (binding.room_id !== roomId) throw protocolError('invalid_credential');
  const room = requireRoom(roomId);
  if (!openStore.hasAi(room, binding.agent_id)) {
    throw protocolError('not_joined');
  }
  return { room, agent_id: binding.agent_id, binding, token };
}

/**
 * Join body: party must be human|ai; identity must match party shape.
 * Cross-pose → invalid_party (also not_human / not_ai when shape is clearly wrong).
 */
function parseJoinIdentity(req) {
  const body = req.body || {};
  const { party, handle: rawHandle, agent_id: rawAgent } = body;
  const bearer = extractBearer(req);
  const hasHandle = rawHandle !== undefined && rawHandle !== null && String(rawHandle).length > 0;
  const hasAgent = rawAgent !== undefined && rawAgent !== null && String(rawAgent).length > 0;

  if (party === undefined || party === null) {
    throw protocolError('invalid_request', 'party must be declared as "human" or "ai".');
  }
  if (party !== 'human' && party !== 'ai') {
    throw protocolError('invalid_party');
  }

  if (party === 'human') {
    // AI bearer or agent-shaped-only claim → cross-pose
    if (bearer) {
      throw protocolError('invalid_party', 'AI bearer cannot join Open as human.');
    }
    if (!hasHandle && hasAgent) {
      throw protocolError('invalid_party', 'agent_id alone cannot join as human.');
    }
    return { kind: 'human', handle: validateHandle(rawHandle) };
  }

  // party === 'ai' — human handle without agent_id is cross-pose
  if (!hasAgent && hasHandle) {
    throw protocolError('invalid_party', 'Human handle cannot join Open as ai.');
  }
  return { kind: 'ai', agent_id: validateAgentId(rawAgent) };
}

/** POST /rooms — create empty Open room (no auto-join). */
router.post('/rooms', (req, res) => {
  try {
    const body = req.body || {};
    if (body.party !== undefined && body.party !== null) {
      // create is untyped; do not accept a party claim that implies joining as one kind
      if (body.party !== 'human' && body.party !== 'ai') {
        throw protocolError('invalid_party');
      }
    }
    const room = openStore.createRoom();
    res.status(201).json({
      room_id: room.id,
      ...roomMeta(room),
      created_at: room.created_at,
    });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /rooms/:id/join */
router.post('/rooms/:id/join', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const identity = parseJoinIdentity(req);

    if (identity.kind === 'human') {
      openStore.joinHuman(room, identity.handle);
      return res.json({
        ...roomMeta(room),
        roster: openStore.listRoster(room),
      });
    }

    const { credential } = openStore.joinAi(room, identity.agent_id);
    res.json({
      ...roomMeta(room),
      credential,
      roster: openStore.listRoster(room),
    });
  } catch (err) {
    if (err.code === 'room_full') return sendError(res, protocolError('room_full'));
    sendError(res, err);
  }
});

/**
 * POST /rooms/:id/post
 * human: { handle, body } → party forced "human"
 * ai: Authorization: Bearer; { body } → party forced "ai"
 */
router.post('/rooms/:id/post', (req, res) => {
  try {
    const roomId = req.params.id;
    const bodyIn = req.body || {};
    const bearer = extractBearer(req);
    const { handle: rawHandle, body: rawBody, party, agent_id: rawAgent } = bodyIn;

    let author;
    let forcedParty;

    if (bearer) {
      // AI credential path — refuse human pose
      if (party === 'human' || (rawHandle !== undefined && rawHandle !== null && rawHandle !== '')) {
        throw protocolError('invalid_party');
      }
      if (party !== undefined && party !== null && party !== 'ai') {
        throw protocolError('invalid_party');
      }
      const { room, agent_id: agentId } = requireAiCredential(req, roomId);
      author = agentId;
      forcedParty = 'ai';
      const body = validateBody(rawBody);
      const message = {
        id: `msg_${crypto.randomBytes(6).toString('hex')}`,
        room_id: room.id,
        author,
        party: forcedParty,
        body,
        created_at: new Date().toISOString(),
      };
      room.messages.push(message);
      return res.status(201).json({ message });
    }

    // Human handle path
    if (party === 'ai' || (rawAgent !== undefined && rawAgent !== null && rawAgent !== '')) {
      throw protocolError('invalid_party');
    }
    if (party !== undefined && party !== null && party !== 'human') {
      throw protocolError('invalid_party');
    }
    const room = requireRoom(roomId);
    const handle = validateHandle(rawHandle);
    if (!openStore.hasHuman(room, handle)) {
      throw protocolError('not_joined');
    }
    author = handle;
    forcedParty = 'human';
    const body = validateBody(rawBody);
    const message = {
      id: `msg_${crypto.randomBytes(6).toString('hex')}`,
      room_id: room.id,
      author,
      party: forcedParty,
      body,
      created_at: new Date().toISOString(),
    };
    room.messages.push(message);
    res.status(201).json({ message });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /rooms/:id/messages
 * human: ?handle=
 * ai: Authorization: Bearer ; ?after=
 */
router.get('/rooms/:id/messages', (req, res) => {
  try {
    const roomId = req.params.id;
    const bearer = extractBearer(req);
    let room;

    if (bearer) {
      ({ room } = requireAiCredential(req, roomId));
    } else {
      room = requireRoom(roomId);
      const handle = req.query.handle;
      if (handle === undefined || handle === null || handle === '') {
        throw protocolError('invalid_request', 'Provide ?handle= or Authorization Bearer.');
      }
      if (!openStore.hasHuman(room, String(handle))) {
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
      roster: openStore.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /rooms/:id/leave
 * human: { handle }
 * ai: Authorization: Bearer
 */
router.post('/rooms/:id/leave', (req, res) => {
  try {
    const roomId = req.params.id;
    const bodyIn = req.body || {};
    const bearer = extractBearer(req);
    const { handle: rawHandle, party, agent_id: rawAgent } = bodyIn;

    if (bearer) {
      if (party === 'human' || (rawHandle !== undefined && rawHandle !== null && rawHandle !== '')) {
        throw protocolError('invalid_party');
      }
      const { room, agent_id: agentId } = requireAiCredential(req, roomId);
      openStore.leaveAi(room, agentId);
      const still = openStore.getRoom(roomId);
      return res.json({
        ok: true,
        ...(still
          ? { ...roomMeta(still), roster: openStore.listRoster(still) }
          : { room_id: roomId, layer: 'open', roster: [] }),
      });
    }

    if (party === 'ai' || (rawAgent !== undefined && rawAgent !== null && rawAgent !== '')) {
      throw protocolError('invalid_party');
    }
    const room = requireRoom(roomId);
    const handle = validateHandle(rawHandle);
    // leave if absent: no-op
    openStore.leaveHuman(room, handle);
    const still = openStore.getRoom(roomId);
    res.json({
      ok: true,
      ...(still
        ? { ...roomMeta(still), roster: openStore.listRoster(still) }
        : { room_id: roomId, layer: 'open', roster: [] }),
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
