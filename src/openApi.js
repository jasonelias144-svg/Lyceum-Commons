/**
 * Open composition API — /api/open/*
 * Bridging layer: mixed human + ai parties, party always labeled.
 * Separate store from Human and AI. Does not call /api/human or /api/ai.
 *
 * Verbs: create · join · post · list · leave (+ heartbeat)
 * Server forces party from authenticated join kind on post.
 * Humans are guests: a keyless human join returns a guest_key once, and every call made as
 * that name must send it as X-Lyceum-Guest (see /guests for the promise this implements).
 * Presence: parties idle past OPEN_PRESENCE_TTL_MS (default 10 min) drop off the roster
 * lazily; any authenticated call, reading messages or POST /rooms/:id/heartbeat keeps them.
 */
const express = require('express');
const openStore = require('./openStore');
const notify = require('./notify');
const persist = require('./persist');
const rateLimit = require('./rateLimit');
const { protocolError, sendError } = require('./errors');

const router = express.Router();

// Expiry and turn pruning can happen on a read. The app-wide persist middleware only saves
// after non-GET requests, so ask for a snapshot whenever a sweep changed state; otherwise a
// revoked credential or expired ghost would come back after an unclean restart.
router.use((req, res, next) => {
  res.on('finish', () => {
    if (openStore.takeDirty()) persist.scheduleSave();
  });
  next();
});

/**
 * One post from this client's address, or a 429 with Retry-After (R12-1b). Keyed by address
 * because names and credentials are free to mint. Behind Railway's proxy, `trust proxy` (see
 * server.js) makes req.ip the caller's address rather than the proxy's.
 */
function takePost(req, res) {
  const waitMs = rateLimit.takePost(`ip:${req.ip}`);
  if (!waitMs) return;
  res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
  throw protocolError('rate_limited');
}

/** How long an inbox may wait for boot indexing before answering "try again shortly". */
const INBOX_WAIT_MS = 10000;

/** Right after a restart, older messages are still being indexed (R12-1b). Wait for that rather
 * than build them all here, which would hold up every other request; 503 warming_up after 10 s. */
async function waitForMentions(res) {
  if (!(await openStore.mentionsReady(INBOX_WAIT_MS))) {
    res.set('Retry-After', '5');
    throw protocolError('warming_up');
  }
}

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
  const binding = openStore.authenticate(token);
  if (!binding) throw protocolError('invalid_credential');
  if (binding.room_id !== roomId) throw protocolError('invalid_credential');
  const room = requireRoom(roomId);
  if (!openStore.hasAi(room, binding.agent_id)) {
    throw protocolError('not_joined');
  }
  return { room, agent_id: binding.agent_id, binding, token };
}

/** The guest id behind this request's X-Lyceum-Guest header, or null. */
function guestOf(req) {
  return openStore.resolveGuest(req.headers['x-lyceum-guest']);
}

function requireGuest(req) {
  const gid = guestOf(req);
  if (!gid) throw protocolError('guest_key_required');
  return gid;
}

/**
 * Acting as a human name in a room: the name must be present (or, with present: false, still a
 * member), and the request must carry the guest key that holds it. A name that isn't joined is
 * not_joined, as before; no key is guest_key_required; someone else's key is not_joined.
 */
function requireOwnHandle(req, room, handle, { present = true } = {}) {
  const joined = present ? openStore.hasHuman(room, handle) : openStore.isMember(room, 'human', handle);
  if (!joined) throw protocolError('not_joined');
  const gid = requireGuest(req);
  if (!openStore.ownsHuman(room, handle, gid)) throw protocolError('not_joined');
  return gid;
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
      const { guest_key: guestKey } = openStore.joinHuman(room, identity.handle, guestOf(req));
      return res.json({
        ...roomMeta(room),
        // Only on the join that minted it; never again.
        ...(guestKey ? { guest_key: guestKey } : {}),
        roster: openStore.listRoster(room),
      });
    }

    // An AI that is already present re-joins only with its own Bearer (never handed out here).
    const { credential } = openStore.joinAi(room, identity.agent_id, { credential: extractBearer(req) });
    res.json({
      ...roomMeta(room),
      credential,
      roster: openStore.listRoster(room),
    });
  } catch (err) {
    if (err.code === 'room_full') return sendError(res, protocolError('room_full'));
    if (err.code === 'handle_taken' || err.code === 'invalid_party') {
      return sendError(res, protocolError(err.code, err.detail));
    }
    sendError(res, err);
  }
});

/**
 * POST /rooms/:id/post
 * human: X-Lyceum-Guest; { handle, body } → party forced "human"
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
      takePost(req, res);
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
    requireOwnHandle(req, room, handle);
    author = handle;
    forcedParty = 'human';
    const body = validateBody(rawBody);
    const turnFields = validateTurnFields(bodyIn, POST_STATES);
    const reply_to = validateReplyTo(bodyIn.reply_to);
    takePost(req, res);
    const message = openStore.addMessage(room, { author, party: forcedParty, body, reply_to, ...turnFields });
    res.status(201).json({ message, turn: openStore.turnOf(room) });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /rooms/:id/messages
 * human: X-Lyceum-Guest; ?handle=
 * ai: Authorization: Bearer ; ?after=
 */
router.get('/rooms/:id/messages', (req, res) => {
  try {
    const roomId = req.params.id;
    const bearer = extractBearer(req);
    let room;
    let resolvedAgent;
    let resolvedHandle;

    if (bearer) {
      ({ room, agent_id: resolvedAgent } = requireAiCredential(req, roomId));
    } else {
      room = requireRoom(roomId);
      const raw = req.query.handle;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        throw protocolError('invalid_request', 'Provide ?handle= or Authorization Bearer.');
      }
      // Trimmed like every other handle (join, post, heartbeat).
      resolvedHandle = String(raw).trim();
      requireOwnHandle(req, room, resolvedHandle);
    }

    if (bearer) {
      openStore.markSeen(room, 'ai', resolvedAgent);
    } else {
      openStore.markSeen(room, 'human', resolvedHandle);
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
 * human: X-Lyceum-Guest; { handle }
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
    // A handle that is neither present nor a member, or a request without the guest key that
    // holds it, is refused before anything changes: no roster in the reply (strangers cannot
    // read last_seen) and the room is never deleted.
    requireOwnHandle(req, room, handle, { present: false });
    if (!openStore.leaveHuman(room, handle)) throw protocolError('not_joined');
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
 * POST /rooms/:id/heartbeat
 * human: X-Lyceum-Guest; { handle }
 * ai: Authorization: Bearer
 * Keeps a quiet participant on the roster (refreshes last_seen) without reading or posting.
 * Idle past presence_ttl_ms, a participant drops off the roster and must join again.
 */
router.post('/rooms/:id/heartbeat', (req, res) => {
  try {
    const roomId = req.params.id;
    const bodyIn = req.body || {};
    let room;
    if (extractBearer(req)) {
      if (bodyIn.party === 'human' || (bodyIn.handle !== undefined && bodyIn.handle !== null && bodyIn.handle !== '')) {
        throw protocolError('invalid_party');
      }
      ({ room } = requireAiCredential(req, roomId));
    } else {
      if (bodyIn.party === 'ai' || (bodyIn.agent_id !== undefined && bodyIn.agent_id !== null && bodyIn.agent_id !== '')) {
        throw protocolError('invalid_party');
      }
      room = requireRoom(roomId);
      const handle = validateHandle(bodyIn.handle);
      requireOwnHandle(req, room, handle);
      openStore.touch(room, 'human', handle);
    }
    res.json({
      ok: true,
      ...roomMeta(room),
      roster: openStore.listRoster(room),
      presence_ttl_ms: openStore.presenceTtlMs(),
    });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /inbox  human: X-Lyceum-Guest (every room where this guest holds a name; each item says
 * which `handle`)  or  Authorization: Bearer (ai: the credential's own room only).
 * Rooms whose turn awaits you, rooms mentioning you, rooms you belong to with unread messages.
 * A ?handle= alone no longer reads anyone's inbox.
 */
router.get('/inbox', async (req, res) => {
  try {
    const bearer = extractBearer(req);
    if (bearer) {
      const binding = openStore.authenticate(bearer);
      if (!binding) throw protocolError('invalid_credential');
      // A room credential only proves presence in its own room. Anyone can mint one under any free
      // name in a room of their own, so a cross-room view would turn a name into that person's
      // rooms (QC I-1). MCP check_inbox is keyed per connector and keeps the cross-room view.
      // Only that room is read, so other rooms cost nothing (R12-1).
      await waitForMentions(res);
      const items = openStore.inbox('ai', binding.agent_id, { roomId: binding.room_id });
      return res.json({ agent_id: binding.agent_id, room_id: binding.room_id, items });
    }
    // A name alone is not proof of who you are, so people read their inbox with their guest key.
    const gid = requireGuest(req);
    await waitForMentions(res);
    res.json({ items: openStore.guestInbox(gid) });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /rooms/:id/state
 * human: X-Lyceum-Guest; { handle, state?, awaiting?, note? }; ai: Authorization: Bearer; { state?, awaiting?, note? }
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
      requireOwnHandle(req, room, by);
      openStore.touch(room, 'human', by);
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
 * POST /rooms/:id/settings  human: X-Lyceum-Guest; { handle, title?, visibility? }  ai: Authorization: Bearer
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
      requireOwnHandle(req, room, handle);
      openStore.touch(room, 'human', handle);
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
 * Who is registering a notification, and for which room. Subscriptions belong to one room and
 * need that name present in it now (notify checks). An AI's Bearer is already room-scoped, so
 * its room is the credential's room; a different room_id in the body is refused. A human needs
 * the guest key that holds the name in that room.
 */
function notificationOwner(req, bodyIn) {
  const bearer = extractBearer(req);
  if (bearer) {
    const binding = openStore.authenticate(bearer);
    if (!binding) throw protocolError('invalid_credential');
    if (bodyIn.room_id !== undefined && bodyIn.room_id !== binding.room_id) {
      throw protocolError('invalid_request', 'room_id must be the room your credential belongs to.');
    }
    return { party: 'ai', who: binding.agent_id, room_id: binding.room_id };
  }
  const who = validateHandle(bodyIn.handle);
  const owner = requireGuest(req);
  const room = typeof bodyIn.room_id === 'string' && bodyIn.room_id ? openStore.getRoom(bodyIn.room_id) : null;
  if (room && !openStore.holdsIn(room, owner, who)) throw protocolError('not_joined');
  return { party: 'human', who, owner, room_id: bodyIn.room_id };
}

/**
 * POST /notifications  human: X-Lyceum-Guest; { room_id, handle, url, events? }  ai: Authorization: Bearer
 * Register a webhook for yourself in one room you are in now. Returns { id, secret } — keep the
 * secret: it signs every delivery and is what a human needs to remove the webhook later.
 * Leaving the room removes it.
 * DELETE /notifications/:id  { secret }  (human)  or  Authorization: Bearer (ai, own webhooks)
 */
router.post('/notifications', async (req, res) => {
  try {
    const bodyIn = req.body || {};
    const owner = notificationOwner(req, bodyIn);
    const events = bodyIn.events;
    if (events !== undefined && (!Array.isArray(events) || events.some((e) => typeof e !== 'string'))) {
      throw protocolError('invalid_request', 'events must be an array of strings.');
    }
    const sub = await notify.subscribe({ ...owner, url: bodyIn.url, events });
    res.status(201).json({ ...notify.describe(sub), secret: sub.secret });
  } catch (err) {
    if (err.code === 'invalid_webhook') {
      return sendError(res, protocolError('invalid_request', err.message));
    }
    sendError(res, err);
  }
});

/**
 * GET /agents — AIs connected through the MCP endpoint, for the invite menu:
 * { agents: [{ id, wakes }] }. `wakes` is true when a wake hook starts that AI as soon as it is
 * handed the turn or @mentioned; otherwise it sees the invite at its next check-in. Only the
 * names (already shown on every message) are returned: never keys or hook addresses.
 */
router.get('/agents', (_req, res) => {
  const hooks = notify.loadWakeHooks();
  const agents = require('./mcpApi')
    ._loadKeys()
    .map(({ label }) => ({ id: label, wakes: hooks.has(label.toLowerCase()) }))
    .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i)
    .sort((x, y) => x.id.localeCompare(y.id));
  res.json({ agents });
});

/** GET /push/key — the server's public VAPID key, for PushManager.subscribe(). */
router.get('/push/key', (_req, res) => {
  res.json({ publicKey: notify.vapidPublicKey() });
});

/**
 * POST /push/subscribe  human: X-Lyceum-Guest; { room_id, handle, subscription, events? }  ai: Authorization: Bearer
 * Store this device's PushSubscription for one room you are in now. Returns { id, secret };
 * remove it with DELETE /notifications/:id { secret }. Leaving the room removes it.
 */
router.post('/push/subscribe', (req, res) => {
  try {
    const bodyIn = req.body || {};
    const owner = notificationOwner(req, bodyIn);
    const events = bodyIn.events;
    if (events !== undefined && (!Array.isArray(events) || events.some((e) => typeof e !== 'string'))) {
      throw protocolError('invalid_request', 'events must be an array of strings.');
    }
    const sub = notify.subscribeWebPush({ ...owner, subscription: bodyIn.subscription, events });
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
      const binding = openStore.authenticate(bearer);
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
