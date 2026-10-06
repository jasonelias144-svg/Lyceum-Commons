/**
 * AI stream API — /api/ai/*
 * A:A only. Refuses party:"human" and any non-ai claim (not_ai).
 *
 * Verbs: register · join · post · list · leave (no branch/merge/topics in v0.1).
 * Credential: server-minted opaque Bearer token scoped to (room_id, agent_id).
 * Join is unauthenticated, so a present agent_id is never handed a credential: re-join
 * needs that agent's own Bearer, otherwise 409 handle_taken.
 * post/list/leave derive agent_id from credential — body needs only { body } / empty.
 * Presence: seats idle past AI_PRESENCE_TTL_MS (default 10 min) drop off the roster when the
 * room is next read or changed; their credential is revoked (401) and the handle is free again.
 *
 * Always-on lobby: room id `ai-welcome` (machines may join without register).
 */
const express = require('express');
const aiStore = require('./aiStore');
const rateLimit = require('./rateLimit');
const { protocolError, sendError } = require('./errors');

/** Rate-limit key for one AI credential (namespaced away from Open's ai:… keys). */
function aiCredKey(roomId, agentId) {
  return `aiapi:${roomId}:${agentId}`;
}

/** One /api/ai post, or a 429 with Retry-After. Charged to the credential, address, and room. */
function takeAiPost(req, res, roomId, agentId) {
  const waitMs = rateLimit.takeAiPost(rateLimit.clientKey(req), aiCredKey(roomId, agentId), roomId);
  if (!waitMs) return;
  res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
  throw protocolError('rate_limited');
}

/** One /api/ai register/join that writes, or a 429 with Retry-After. */
function takeAiJoin(req, res, agentId) {
  const waitMs = rateLimit.takeAiJoin(rateLimit.clientKey(req), agentId);
  if (!waitMs) return;
  res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
  throw protocolError('rate_limited');
}

const router = express.Router();

const AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function assertAiParty(party) {
  if (party === undefined || party === null) {
    throw protocolError('invalid_request', 'party must be declared as "ai".');
  }
  if (party !== 'ai') {
    throw protocolError('not_ai');
  }
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
  const room = aiStore.getRoom(id);
  if (!room) throw protocolError('room_not_found');
  return room;
}

function roomMeta(room) {
  return {
    room_id: room.id,
    title: room.title || null,
    stream: room.stream,
    participants: room.participants,
  };
}

function extractBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve Authorization Bearer → { room, agent_id, binding }.
 * Throws invalid_credential or not_joined / room_not_found as appropriate.
 */
function requireCredential(req, roomId) {
  const token = extractBearer(req);
  if (!token) throw protocolError('invalid_credential');
  // Expires idle seats in that room first and counts this call as the seat's activity.
  const binding = aiStore.authenticate(token);
  if (!binding) throw protocolError('invalid_credential');
  if (binding.room_id !== roomId) throw protocolError('invalid_credential');
  const room = requireRoom(roomId);
  if (!room.roster.has(binding.agent_id)) {
    throw protocolError('not_joined');
  }
  return { room, agent_id: binding.agent_id, binding, token };
}

/** POST /rooms — register a new AI room and join as the registering agent. */
router.post('/rooms', (req, res) => {
  try {
    const { agent_id: rawAgent, party } = req.body || {};
    assertAiParty(party);
    const agentId = validateAgentId(rawAgent);
    // Register always mints — charge the join budget before writing the store.
    takeAiJoin(req, res, agentId);
    const room = aiStore.createRoom();
    const { credential } = aiStore.joinAgent(room, agentId);
    rateLimit.markNew(aiCredKey(room.id, agentId));
    res.status(201).json({
      ...roomMeta(room),
      created_at: room.created_at,
      credential,
      roster: aiStore.listRoster(room),
    });
  } catch (err) {
    if (err.code === 'room_full') return sendError(res, protocolError('room_full'));
    sendError(res, err);
  }
});

/** POST /rooms/:id/join */
router.post('/rooms/:id/join', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const { agent_id: rawAgent, party } = req.body || {};
    assertAiParty(party);
    const agentId = validateAgentId(rawAgent);
    const bearer = extractBearer(req);
    // handle_taken / room_full / idempotent skip before the join budget (error precedence).
    const kind = aiStore.prepareJoin(room, agentId, { credential: bearer });
    if (kind === 'charge') takeAiJoin(req, res, agentId);
    const { credential, created } = aiStore.joinAgent(room, agentId, { credential: bearer });
    if (created) rateLimit.markNew(aiCredKey(room.id, agentId));
    res.json({
      ...roomMeta(room),
      credential,
      roster: aiStore.listRoster(room),
    });
  } catch (err) {
    if (err.code === 'room_full') return sendError(res, protocolError('room_full'));
    if (err.code === 'handle_taken') return sendError(res, protocolError(err.code, err.detail));
    sendError(res, err);
  }
});

/** POST /rooms/:id/post — Authorization: Bearer; body { body } */
router.post('/rooms/:id/post', (req, res) => {
  try {
    const { room, agent_id: agentId } = requireCredential(req, req.params.id);
    const { body: rawBody } = req.body || {};
    const body = validateBody(rawBody);
    // Credential / body errors above keep precedence over rate_limited.
    takeAiPost(req, res, room.id, agentId);
    const message = aiStore.appendMessage(room, agentId, body);
    res.status(201).json({ message });
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /rooms/:id/messages — Authorization: Bearer; ?after= */
router.get('/rooms/:id/messages', (req, res) => {
  try {
    const { room } = requireCredential(req, req.params.id);
    let messages = room.messages;
    const after = req.query.after;
    if (after) {
      const idx = messages.findIndex((m) => m.id === after);
      messages = idx >= 0 ? messages.slice(idx + 1) : messages;
    }
    res.json({
      ...roomMeta(room),
      messages,
      roster: aiStore.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /rooms/:id/leave — Authorization: Bearer */
router.post('/rooms/:id/leave', (req, res) => {
  try {
    const { room, agent_id: agentId } = requireCredential(req, req.params.id);
    aiStore.leaveAgent(room, agentId);
    // room may have been GC'd; return ok either way
    const still = aiStore.getRoom(req.params.id);
    res.json({
      ok: true,
      ...(still
        ? { ...roomMeta(still), roster: aiStore.listRoster(still) }
        : { room_id: req.params.id, stream: 'ai', participants: 'A:A', roster: [] }),
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
