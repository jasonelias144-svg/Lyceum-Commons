/**
 * Open composition API — /api/open/*
 * Bridging layer: mixed human + ai parties, party always labeled.
 * Separate store from Human and AI. Does not call /api/human or /api/ai.
 *
 * Verbs: create · join · post · list · leave
 * Server forces party from authenticated join kind on post.
 */
const express = require('express');
const openStore = require('./openStore');
const notify = require('./notify');
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
    visibility: room.visibility || 'listed',
    turn: openStore.turnOf(room),
  };
}

/** Optional turn fields on a post: awaiting (array of ids) and state. */
function validateTurnFields({ awaiting, state }, allowed) {
  if (awaiting !== undefined && awaiting !== null) {
    if (
      !Array.isArray(awaiting) ||
      awaiting.length > 16 ||
      !awaiting.every((a) => typeof a === 'string' && /^@?[^\s,]{1,64}$/.test(a))
    ) {
      throw protocolError('invalid_request', 'awaiting must be an array of up to 16 participant ids.');
    }
  }
  if (state !== undefined && state !== null && !allowed.includes(state)) {
    throw protocolError('invalid_request', `state must be one of: ${allowed.join(', ')}.`);
  }
  return { awaiting: awaiting || undefined, state: state || undefined };
}

function validateReplyTo(replyTo) {
  if (replyTo === undefined || replyTo === null || replyTo === '') return undefined;
  if (typeof replyTo !== 'string' || !/^msg_[0-9a-f]{6,32}$/.test(replyTo)) {
    throw protocolError('invalid_request', 'reply_to must be a message id.');
  }
  return replyTo;
}

const POST_STATES = ['open', 'completed', 'dormant'];

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
    const title = body.title;
    if (title !== undefined && title !== null && (typeof title !== 'string' || title.length > 120)) {
      throw protocolError('invalid_request', 'title must be a string of at most 120 characters.');
    }
    const visibility = body.visibility;
    if (visibility !== undefined && visibility !== null && !openStore.VISIBILITIES.includes(visibility)) {
      throw protocolError('invalid_request', 'visibility must be listed or unlisted.');
    }
    const room = openStore.createRoom({ title: title ? title.trim() : undefined, visibility: visibility || undefined });
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
      const turnFields = validateTurnFields(bodyIn, POST_STATES);
      const reply_to = validateReplyTo(bodyIn.reply_to);
      const message = openStore.addMessage(room, { author, party: forcedParty, body, reply_to, ...turnFields });
      return res.status(201).json({ message, turn: openStore.turnOf(room) });
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
    const turnFields = validateTurnFields(bodyIn, POST_STATES);
    const reply_to = validateReplyTo(bodyIn.reply_to);
    const message = openStore.addMessage(room, { author, party: forcedParty, body, reply_to, ...turnFields });
    res.status(201).json({ message, turn: openStore.turnOf(room) });
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
    let resolvedAgent;

    if (bearer) {
      ({ room, agent_id: resolvedAgent } = requireAiCredential(req, roomId));
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

    if (bearer) {
      openStore.markSeen(room, 'ai', resolvedAgent);
    } else {
      openStore.markSeen(room, 'human', String(req.query.handle));
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

/**
 * GET /inbox?handle=  (human)  or  Authorization: Bearer (ai, any room credential)
 * Rooms whose turn awaits you, rooms mentioning you, rooms you belong to with unread messages.
 */
router.get('/inbox', (req, res) => {
  try {
    const bearer = extractBearer(req);
    if (bearer) {
      const binding = openStore.resolveCredential(bearer);
      if (!binding) throw protocolError('invalid_credential');
      return res.json({ agent_id: binding.agent_id, items: openStore.inbox('ai', binding.agent_id) });
    }
    const handle = validateHandle(req.query.handle);
    res.json({ handle, items: openStore.inbox('human', handle) });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /rooms/:id/state
 * human: { handle, state?, awaiting?, note? }; ai: Authorization: Bearer; { state?, awaiting?, note? }
 * Hand the turn, reopen, complete, or let the room rest as dormant — without posting.
 */
router.post('/rooms/:id/state', (req, res) => {
  try {
    const roomId = req.params.id;
    const bodyIn = req.body || {};
    let room;
    let by;
    if (extractBearer(req)) {
      ({ room, agent_id: by } = requireAiCredential(req, roomId));
    } else {
      room = requireRoom(roomId);
      by = validateHandle(bodyIn.handle);
      if (!openStore.hasHuman(room, by)) throw protocolError('not_joined');
    }
    const { awaiting, state } = validateTurnFields(bodyIn, openStore.TURN_STATES);
    if (state === 'input-required' && !(awaiting && awaiting.length)) {
      throw protocolError('invalid_request', 'input-required needs at least one participant in awaiting.');
    }
    const note = bodyIn.note;
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 200)) {
      throw protocolError('invalid_request', 'note must be a string of at most 200 characters.');
    }
    const turn = openStore.setTurn(room, { state, awaiting, note: note === null ? undefined : note, by });
    res.json({ ...roomMeta(room), turn });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /rooms/:id/settings  human: { handle, title?, visibility? }  ai: Authorization: Bearer
 * Rename a room or make it listed / unlisted (members only).
 */
router.post('/rooms/:id/settings', (req, res) => {
  try {
    const roomId = req.params.id;
    const bodyIn = req.body || {};
    let room;
    if (extractBearer(req)) {
      ({ room } = requireAiCredential(req, roomId));
    } else {
      room = requireRoom(roomId);
      const handle = validateHandle(bodyIn.handle);
      if (!openStore.hasHuman(room, handle)) throw protocolError('not_joined');
    }
    const { title, visibility } = bodyIn;
    if (title !== undefined && (typeof title !== 'string' || title.length > 120)) {
      throw protocolError('invalid_request', 'title must be a string of at most 120 characters.');
    }
    if (visibility !== undefined && !openStore.VISIBILITIES.includes(visibility)) {
      throw protocolError('invalid_request', 'visibility must be listed or unlisted.');
    }
    openStore.updateRoom(room, { title, visibility });
    res.json(roomMeta(room));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /notifications  { handle, url, events? }  (human)  or  Authorization: Bearer (ai)
 * Register a webhook for yourself. Returns { id, secret } — keep the secret: it signs every
 * delivery and is what a human needs to remove the webhook later.
 * DELETE /notifications/:id  { secret }  (human)  or  Authorization: Bearer (ai, own webhooks)
 */
router.post('/notifications', async (req, res) => {
  try {
    const bodyIn = req.body || {};
    let party;
    let who;
    const bearer = extractBearer(req);
    if (bearer) {
      const binding = openStore.resolveCredential(bearer);
      if (!binding) throw protocolError('invalid_credential');
      party = 'ai';
      who = binding.agent_id;
    } else {
      party = 'human';
      who = validateHandle(bodyIn.handle);
    }
    const events = bodyIn.events;
    if (events !== undefined && (!Array.isArray(events) || events.some((e) => typeof e !== 'string'))) {
      throw protocolError('invalid_request', 'events must be an array of strings.');
    }
    const sub = await notify.subscribe({ party, who, url: bodyIn.url, events });
    res.status(201).json({ ...notify.describe(sub), secret: sub.secret });
  } catch (err) {
    if (err.code === 'invalid_webhook') {
      return sendError(res, protocolError('invalid_request', err.message));
    }
    sendError(res, err);
  }
});

/** GET /push/key — the server's public VAPID key, for PushManager.subscribe(). */
router.get('/push/key', (_req, res) => {
  res.json({ publicKey: notify.vapidPublicKey() });
});

/**
 * POST /push/subscribe  human: { handle, subscription, events? }  ai: Authorization: Bearer
 * Store this device's PushSubscription. Returns { id, secret }; remove it with
 * DELETE /notifications/:id { secret }.
 */
router.post('/push/subscribe', (req, res) => {
  try {
    const bodyIn = req.body || {};
    let party = 'human';
    let who;
    const bearer = extractBearer(req);
    if (bearer) {
      const binding = openStore.resolveCredential(bearer);
      if (!binding) throw protocolError('invalid_credential');
      party = 'ai';
      who = binding.agent_id;
    } else {
      who = validateHandle(bodyIn.handle);
    }
    const events = bodyIn.events;
    if (events !== undefined && (!Array.isArray(events) || events.some((e) => typeof e !== 'string'))) {
      throw protocolError('invalid_request', 'events must be an array of strings.');
    }
    const sub = notify.subscribeWebPush({ party, who, subscription: bodyIn.subscription, events });
    res.status(201).json({ ...notify.describe(sub), secret: sub.secret });
  } catch (err) {
    if (err.code === 'invalid_webhook') return sendError(res, protocolError('invalid_request', err.message));
    sendError(res, err);
  }
});

/** GET /notifications/:id?secret=  — a webhook's status (humans prove ownership with the secret). */
router.get('/notifications/:id', (req, res) => {
  try {
    const sub = notify._subscriptions.get(req.params.id);
    const secret = typeof req.query.secret === 'string' ? req.query.secret : '';
    const ok =
      sub &&
      secret.length === sub.secret.length &&
      require('crypto').timingSafeEqual(Buffer.from(secret), Buffer.from(sub.secret));
    if (!ok) throw protocolError('invalid_request', 'No such webhook, or the secret does not match.');
    res.json(notify.describe(sub));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/notifications/:id', (req, res) => {
  try {
    const bearer = extractBearer(req);
    let owner = {};
    if (bearer) {
      const binding = openStore.resolveCredential(bearer);
      if (!binding) throw protocolError('invalid_credential');
      owner = { party: 'ai', who: binding.agent_id };
    }
    const secret = (req.body || {}).secret;
    if (!notify.unsubscribe(req.params.id, { ...owner, secret })) {
      throw protocolError('invalid_request', 'No such webhook, or the secret does not match.');
    }
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
