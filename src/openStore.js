/**
 * In-memory Open composition store (v0.1) — SEPARATE from Human and AI stores.
 * Never shares messages/rooms Maps with Human or AI.
 * layer always `open`; roster is mixed { id, party } (human | ai).
 *
 * Seeded: always-on lobby id `open-welcome` (empty until someone joins).
 * AI credentials: server-minted opaque tokens scoped to (room_id, agent_id).
 *
 * Presence: every roster entry carries `last_seen`, refreshed by join, post, reading
 * messages, heartbeat and any other authenticated call. Parties idle longer than the
 * presence TTL (OPEN_PRESENCE_TTL_MS, default 10 minutes, 0 turns expiry off) are
 * expired lazily whenever the room is read or changed; there are no timers.
 * Membership (room.members) is separate from presence: expiry keeps it, leave ends it.
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
const OPEN_WELCOME_ROOM_ID = 'open-welcome';
const OPEN_WELCOME_TITLE = 'Open welcome lobby';
const DEFAULT_PRESENCE_TTL_MS = 10 * 60 * 1000;

/** Injectable clock (tests replace it so nothing has to sleep). */
let clock = () => Date.now();

function now() {
  return clock();
}

function nowIso() {
  return new Date(now()).toISOString();
}

/** Replace the clock; call with no argument to restore Date.now. */
function _setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

const MIN_PRESENCE_TTL_MS = 30 * 1000;
const ttlCache = { raw: undefined, value: DEFAULT_PRESENCE_TTL_MS };

/**
 * Presence TTL in ms from OPEN_PRESENCE_TTL_MS (read on each use, parsed once per value).
 * Only a plain integer string is accepted: 0 turns expiry off, anything below 30000 is
 * raised to 30000, and anything else (spaces, units, hex, decimals, negatives) falls back
 * to the 10-minute default with a warning.
 */
function presenceTtlMs() {
  const raw = process.env.OPEN_PRESENCE_TTL_MS;
  if (raw === ttlCache.raw) return ttlCache.value;
  let value = DEFAULT_PRESENCE_TTL_MS;
  if (raw !== undefined && raw !== '') {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      console.warn(`OPEN_PRESENCE_TTL_MS=${JSON.stringify(raw)} is not a whole number of ms; using ${DEFAULT_PRESENCE_TTL_MS}.`);
    } else {
      value = Number(raw);
      if (value > 0 && value < MIN_PRESENCE_TTL_MS) {
        console.warn(`OPEN_PRESENCE_TTL_MS=${raw} is below the ${MIN_PRESENCE_TTL_MS} ms minimum; using ${MIN_PRESENCE_TTL_MS}.`);
        value = MIN_PRESENCE_TTL_MS;
      }
    }
  }
  ttlCache.raw = raw;
  ttlCache.value = value;
  return value;
}

/** One line for the startup log. */
function describePresenceTtl() {
  const ttl = presenceTtlMs();
  return ttl ? `Open presence TTL: ${ttl} ms` : 'Open presence TTL: off (OPEN_PRESENCE_TTL_MS=0)';
}

/** Set when a sweep changes state (expiry or prune), so reads can ask for a snapshot save. */
let dirty = false;

/** Returns whether a sweep changed state since the last call, and clears the flag. */
function takeDirty() {
  const was = dirty;
  dirty = false;
  return was;
}

/**
 * Presence clock start. Reads (GET) are not written to the snapshot, so after a restart
 * everyone on a restored roster gets one fresh TTL instead of being expired at once.
 */
let presenceEpoch = Date.now();

/** @type {Map<string, object>} */
const openRooms = new Map();
/** @type {Map<string, { room_id: string, agent_id: string }>} */
const credentials = new Map();
/** Each participant's most recent room ("party:id" → room id), the default for address lines. */
const lastRooms = new Map();

function lastRoomOf(party, id) {
  return lastRooms.get(rosterKey(party, id)) || null;
}

/** Called after every post (notifications). A failing listener never breaks posting. */
const messageListeners = [];

function onMessage(fn) {
  messageListeners.push(fn);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function mintCredential() {
  return crypto.randomBytes(24).toString('hex');
}

function rosterKey(party, id) {
  return `${party}:${id}`;
}

function makeRoom({ id, title }) {
  return {
    id,
    title,
    layer: 'open',
    format: 'free_thread',
    /** 'listed' rooms appear in room lists; 'unlisted' ones only to members (link only). */
    visibility: 'listed',
    created_at: nowIso(),
    /** @type {Map<string, { id: string, party: 'human'|'ai', joined_at: string, last_seen?: string, credential?: string }>} */
    roster: new Map(),
    messages: [],
  };
}

function ensureWelcomeLobby() {
  const existing = openRooms.get(OPEN_WELCOME_ROOM_ID);
  if (existing) {
    if (!existing.title) existing.title = OPEN_WELCOME_TITLE;
    return existing;
  }
  const room = makeRoom({ id: OPEN_WELCOME_ROOM_ID, title: OPEN_WELCOME_TITLE });
  openRooms.set(OPEN_WELCOME_ROOM_ID, room);
  return room;
}

const VISIBILITIES = ['listed', 'unlisted'];

function createRoom({ title, visibility } = {}) {
  const id = newId('orm');
  const room = makeRoom({ id, title: title || 'Open room' });
  if (visibility === 'unlisted') room.visibility = 'unlisted';
  openRooms.set(id, room);
  return room;
}

/**
 * Open rooms, lobby first, then oldest first. With a viewer ({ party, id }), unlisted
 * rooms are included only if the viewer is a member. Unlisted is not access control:
 * anyone with the room id can still join (there are no accounts yet).
 */
function listRooms(viewer) {
  const all = Array.from(openRooms.values());
  all.forEach(sweep);
  if (!viewer) return all;
  return all.filter((r) => r.visibility !== 'unlisted' || r.roster.has(rosterKey(viewer.party, viewer.id)));
}

/** Change a room's name and/or visibility. The welcome lobby always stays listed. */
function updateRoom(room, { title, visibility }) {
  if (visibility !== undefined) {
    if (!VISIBILITIES.includes(visibility)) {
      const err = new Error('invalid_visibility');
      err.code = 'invalid_visibility';
      throw err;
    }
    if (room.id !== OPEN_WELCOME_ROOM_ID) room.visibility = visibility;
  }
  if (title !== undefined && title.trim()) room.title = title.trim().slice(0, 120);
  return room;
}

/**
 * Membership is tracked apart from presence (the roster). Joining makes you a member;
 * only an explicit leave ends it. Expiry takes you off the roster (you must join again
 * to post) but keeps your membership, so `message` notifications and inbox unread keep
 * reaching you while you are away. Stored as { "party:id": true } so it snapshots as JSON.
 */
function membersOf(room) {
  if (!room.members || typeof room.members !== 'object') {
    // Rooms from older snapshots: everyone on the roster is a member.
    room.members = {};
    for (const key of room.roster.keys()) room.members[key] = true;
  }
  return room.members;
}

function isMember(room, party, id) {
  const key = rosterKey(party, id);
  return room.roster.has(key) || Boolean(membersOf(room)[key]);
}

/**
 * Turn state, after A2A's task states (see docs/prior-art.md):
 *   open            — anyone may speak
 *   input-required  — waiting on the participants in `awaiting`
 *   completed       — the room's question is settled (a new post reopens it)
 *   dormant         — resting, not dead: a new post revives it with history intact
 * Rooms from older snapshots have no `turn`; it is added on first use.
 */
const TURN_STATES = ['open', 'input-required', 'completed', 'dormant'];

function rawTurn(room) {
  if (!room.turn) {
    room.turn = { state: 'open', awaiting: [], note: null, updated_at: room.created_at, updated_by: null };
  }
  if (!room.seen) room.seen = {};
  return room.turn;
}

/** The room's turn, with awaited participants who are no longer around pruned first. */
function turnOf(room) {
  const turn = rawTurn(room);
  pruneAwaiting(room);
  return turn;
}

function sameId(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function cleanAwaiting(list, except) {
  const out = [];
  for (const raw of list || []) {
    const id = String(raw).trim().replace(/^@/, '');
    if (!id || (except && sameId(id, except))) continue;
    if (!out.some((x) => sameId(x, id))) out.push(id);
  }
  return out;
}

/**
 * Set the turn state directly (without posting). `awaiting` non-empty forces
 * input-required; input-required with nobody awaited falls back to open.
 */
function setTurn(room, { state, awaiting, note, by }, fresh) {
  const turn = turnOf(room);
  if (state !== undefined && !TURN_STATES.includes(state)) {
    const err = new Error('invalid_state');
    err.code = 'invalid_state';
    throw err;
  }
  if (awaiting !== undefined) turn.awaiting = cleanAwaiting(awaiting);
  if (state !== undefined) turn.state = state;
  if (awaiting !== undefined && turn.awaiting.length && state === undefined) turn.state = 'input-required';
  if (turn.state !== 'input-required') turn.awaiting = [];
  if (turn.state === 'input-required' && turn.awaiting.length === 0) turn.state = 'open';
  if (note !== undefined) turn.note = note || null;
  // Handing the turn (directly, or the `fresh` ids of a post) restarts that id's grace clock.
  stampAwaiting(room, fresh === undefined ? awaiting : fresh);
  turn.updated_at = nowIso();
  turn.updated_by = by || null;
  return turn;
}

/**
 * When each awaited id was handed the turn (lower-cased id → ms), kept on the room so the
 * turn object's shape is unchanged. Ids from older snapshots fall back to turn.updated_at.
 */
function awaitingSince(room) {
  const turn = rawTurn(room);
  if (!room.awaiting_since || typeof room.awaiting_since !== 'object') room.awaiting_since = {};
  const since = room.awaiting_since;
  const legacy = Date.parse(turn.updated_at) || now();
  const keep = {};
  for (const id of turn.awaiting) {
    const k = String(id).toLowerCase();
    keep[k] = typeof since[k] === 'number' ? since[k] : legacy;
  }
  room.awaiting_since = keep;
  return keep;
}

function stampAwaiting(room, ids) {
  const since = awaitingSince(room);
  const t = now();
  for (const id of cleanAwaiting(ids)) {
    const k = id.toLowerCase();
    if (k in since) since[k] = t;
  }
}

/**
 * Is anyone with this id on the roster (of either party, or only `party` if given)? Turn logic
 * (awaiting, pruning, implicit handoff) always compares ids this one case-insensitive way.
 */
function inRoster(room, id, party) {
  for (const p of room.roster.values()) if ((!party || p.party === party) && sameId(p.id, id)) return true;
  return false;
}

/** input-required with nobody left to wait for falls back to open (same rule as setTurn). */
function settleTurn(turn, by) {
  if (turn.state === 'input-required' && turn.awaiting.length === 0) turn.state = 'open';
  turn.updated_at = nowIso();
  turn.updated_by = by || null;
}

/**
 * Self-heal: drop awaited ids that are not on the roster, unless they were handed the turn,
 * or timed out, within the last presence TTL (so an AI that is being woken, or an invitee,
 * has time to arrive). An absent awaited id therefore lingers at most one TTL. Stale lists
 * such as awaiting participants who left long ago clear on first read.
 */
function pruneAwaiting(room) {
  const turn = rawTurn(room);
  if (!turn.awaiting.length) {
    room.awaiting_since = {};
    return false;
  }
  const since = awaitingSince(room);
  const grace = presenceTtlMs() || DEFAULT_PRESENCE_TTL_MS;
  const t = now();
  const kept = turn.awaiting.filter((id) => inRoster(room, id) || t - since[String(id).toLowerCase()] <= grace);
  if (kept.length === turn.awaiting.length) return false;
  turn.awaiting = kept;
  awaitingSince(room);
  settleTurn(turn, null);
  dirty = true;
  return true;
}

/** A participant left: stop awaiting them now (unless someone with the same id remains). */
function dropAwaiting(room, id) {
  const turn = rawTurn(room);
  if (inRoster(room, id) || !turn.awaiting.some((a) => sameId(a, id))) return;
  turn.awaiting = turn.awaiting.filter((a) => !sameId(a, id));
  awaitingSince(room);
  settleTurn(turn, id);
}

/**
 * Append a message. `party` is decided by the caller's authenticated path,
 * never by the message content. Optional `turn_id` / `status` carry the
 * inquiry turn format (e.g. "SBO-012-Claude", "awaiting Grok").
 *
 * Turn effects: the author stops being awaited; a post into a completed or
 * dormant room reopens it; `awaiting` hands the turn to the named participants;
 * a human post that names nobody, right after an AI's message, hands the turn to that AI;
 * `reply_to` (a message id in this room) links the post to the message it answers;
 * `state` (completed | dormant | open) sets the room state after this post.
 */
function addMessage(room, { author, party, body, turn_id, status, awaiting, state, reply_to }) {
  const turn = turnOf(room);
  const message = {
    id: `msg_${crypto.randomBytes(6).toString('hex')}`,
    room_id: room.id,
    author,
    party,
    body,
    created_at: nowIso(),
  };
  if (turn_id) message.turn_id = turn_id;
  if (status) message.status = status;
  if (reply_to) {
    const target = room.messages.find((m) => m.id === reply_to);
    if (target) {
      message.reply_to = target.id;
      message.reply_to_author = target.author;
    }
  }
  let handTo = cleanAwaiting(awaiting, author);
  // A person answering straight after an AI, without naming anyone, is replying to that AI:
  // hand it the turn. Humans only, so two AIs can never wake each other in a loop.
  const prev = room.messages[room.messages.length - 1];
  if (
    !handTo.length &&
    !state &&
    party === 'human' &&
    prev &&
    prev.party === 'ai' &&
    inRoster(room, prev.author, 'ai') &&
    !/(^|\s)@[^\s@]/.test(body)
  ) {
    handTo = [prev.author];
    message.implicit_turn = true;
  }
  if (handTo.length) message.awaiting = handTo;
  room.messages.push(message);

  let nextAwaiting = turn.awaiting.filter((id) => !sameId(id, author));
  let nextState = turn.state === 'completed' || turn.state === 'dormant' ? 'open' : turn.state;
  if (handTo.length) {
    nextAwaiting = cleanAwaiting([...nextAwaiting, ...handTo]);
    nextState = 'input-required';
  }
  if (state) nextState = state;
  setTurn(room, { state: nextState, awaiting: nextAwaiting, note: null, by: author }, handTo);
  touch(room, party, author);
  room.seen[rosterKey(party, author)] = message.id;
  lastRooms.set(rosterKey(party, author), room.id);
  for (const fn of messageListeners) {
    try {
      fn(room, message);
    } catch (err) {
      console.error('Message listener failed:', err);
    }
  }
  return message;
}

/** Record that a participant has read the room up to its latest message. */
function markSeen(room, party, id) {
  turnOf(room);
  touch(room, party, id);
  const last = room.messages[room.messages.length - 1];
  if (last) room.seen[rosterKey(party, id)] = last.id;
}

/**
 * What is waiting for a participant across all rooms: rooms whose turn awaits
 * them, and rooms they belong to (or are mentioned in) with unread messages.
 */
function inbox(party, id) {
  const key = rosterKey(party, id);
  const mentionRe = new RegExp(`@${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const items = [];
  for (const room of openRooms.values()) {
    sweep(room);
    const turn = turnOf(room);
    const seenId = room.seen[key];
    const idx = seenId ? room.messages.findIndex((m) => m.id === seenId) : -1;
    const unread = room.messages.slice(idx + 1).filter((m) => !(m.party === party && sameId(m.author, id)));
    const awaited = turn.state === 'input-required' && turn.awaiting.some((a) => sameId(a, id));
    const mentions = unread.filter((m) => mentionRe.test(m.body)).length;
    const member = isMember(room, party, id);
    if (!awaited && !mentions && !(member && unread.length)) continue;
    const last = room.messages[room.messages.length - 1];
    items.push({
      room_id: room.id,
      title: room.title,
      state: turn.state,
      awaiting: turn.awaiting.slice(),
      your_turn: awaited,
      unread: unread.length,
      mentions,
      first_unread: unread.length ? unread[0].id : null,
      last_activity: last ? last.created_at : room.created_at,
    });
  }
  items.sort((a, b) => Number(b.your_turn) - Number(a.your_turn) || b.last_activity.localeCompare(a.last_activity));
  return items;
}

/** Look up a room; expires idle parties and prunes the turn before anyone sees it. */
function getRoom(id) {
  const room = openRooms.get(id) || null;
  if (room) sweep(room);
  return room;
}

function listRoster(room) {
  return Array.from(room.roster.values()).map((p) => ({
    id: p.id,
    party: p.party,
    joined_at: p.joined_at,
    last_seen: p.last_seen || p.joined_at,
  }));
}

/** Record activity by a participant (no-op if they are not on the roster). */
function touch(room, party, id) {
  const entry = room.roster.get(rosterKey(party, id));
  if (entry) entry.last_seen = nowIso();
  return Boolean(entry);
}

function lastSeenMs(entry) {
  const seen = Date.parse(entry.last_seen || entry.joined_at) || 0;
  return Math.max(seen, presenceEpoch);
}

/**
 * Expire parties idle longer than the presence TTL, through the same path as leave
 * (AI credentials are revoked). Unlike an explicit leave, expiry never deletes the room:
 * an idle room keeps its history. Returns the expired { id, party } entries.
 */
function expireIdle(room) {
  membersOf(room);
  const ttl = presenceTtlMs();
  const t = now();
  const expired = [];
  for (const entry of Array.from(room.roster.values())) {
    const seen = lastSeenMs(entry);
    // Restored entries (no last_seen, or one from before this boot) show the boot time.
    if (!entry.last_seen || Date.parse(entry.last_seen) < seen) entry.last_seen = new Date(seen).toISOString();
    if (ttl && t - seen > ttl) {
      removeParty(room, entry.party, entry.id, { dropTurn: false });
      restartGrace(room, entry.id, seen + ttl);
      expired.push({ id: entry.id, party: entry.party });
    }
  }
  if (expired.length) dirty = true;
  return expired;
}

/** An awaited party that just timed out keeps the turn for one TTL from its expiry. */
function restartGrace(room, id, at) {
  if (!rawTurn(room).awaiting.some((a) => sameId(a, id))) return;
  const since = awaitingSince(room);
  const k = String(id).toLowerCase();
  since[k] = Math.max(since[k], at);
}

/** Lazy housekeeping on every read or change: expire idle parties, then prune the turn. */
function sweep(room) {
  const expired = expireIdle(room);
  pruneAwaiting(room);
  return expired;
}

function identityError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/**
 * One name per participant in a room, across both parties and regardless of case, so turn
 * logic (which compares ids case-insensitively) can never confuse two participants. A new
 * identity may not take a name that someone present or kept as a member already holds:
 * the exact name held by the other party is `invalid_party`; any other case variant is
 * `handle_taken`. An existing identity (same party, same case) always passes: that is a
 * rejoin, and it keeps working for duplicates restored from older snapshots.
 */
function assertIdFree(room, party, id) {
  const key = rosterKey(party, id);
  const members = membersOf(room);
  if (room.roster.has(key) || members[key]) return;
  const held = new Set([...room.roster.keys(), ...Object.keys(members)]);
  for (const k of held) {
    const i = k.indexOf(':');
    const otherParty = k.slice(0, i);
    const otherId = k.slice(i + 1);
    if (!sameId(otherId, id)) continue;
    if (otherParty !== party && otherId === id) {
      throw identityError('invalid_party', `${id} is already in this room as ${otherParty === 'ai' ? 'an AI' : 'a human'}.`);
    }
    throw identityError('handle_taken', `${otherId} is already in this room; names are compared without regard to case.`);
  }
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function assertCapacity(room) {
  if (room.roster.size >= MAX_PARTIES) {
    const err = new Error('room_full');
    err.code = 'room_full';
    throw err;
  }
}

/**
 * Join (or re-join) a human. Returns { room, created }.
 */
function joinHuman(room, handle) {
  const key = rosterKey('human', handle);
  assertIdFree(room, 'human', handle);
  if (room.roster.has(key)) {
    touch(room, 'human', handle);
    membersOf(room)[key] = true;
    return { room, created: false };
  }
  assertCapacity(room);
  const at = nowIso();
  room.roster.set(key, {
    id: handle,
    party: 'human',
    joined_at: at,
    last_seen: at,
  });
  membersOf(room)[key] = true;
  return { room, created: true };
}

/**
 * Join (or re-join) an AI agent. Returns { room, credential, created }.
 *
 * The join route is unauthenticated, so an agent that is already present never has its live
 * credential handed out: a re-join must present that credential (`auth.credential`, the
 * request's Bearer), and gets the same membership and the same token back; anyone else gets
 * `handle_taken`. `auth.trusted` is for callers that have already authenticated the agent
 * by other means (the MCP endpoint's connector key). An agent that is absent (never joined,
 * left, or timed out) joins fresh and gets a new credential.
 */
function joinAi(room, agentId, auth = {}) {
  const key = rosterKey('ai', agentId);
  assertIdFree(room, 'ai', agentId);
  if (room.roster.has(key)) {
    const existing = room.roster.get(key);
    const live = Boolean(existing.credential) && credentials.has(existing.credential);
    const proven = live && sameSecret(auth.credential, existing.credential);
    if (!proven && !auth.trusted) {
      throw identityError(
        'handle_taken',
        `${agentId} is already present in this room. Re-join with its Bearer credential, or join after it leaves or times out.`
      );
    }
    if (!live) {
      const token = mintCredential();
      existing.credential = token;
      credentials.set(token, { room_id: room.id, agent_id: agentId });
    }
    touch(room, 'ai', agentId);
    membersOf(room)[key] = true;
    return { room, credential: existing.credential, created: false };
  }
  assertCapacity(room);
  const token = mintCredential();
  const at = nowIso();
  room.roster.set(key, {
    id: agentId,
    party: 'ai',
    joined_at: at,
    last_seen: at,
    credential: token,
  });
  credentials.set(token, { room_id: room.id, agent_id: agentId });
  membersOf(room)[key] = true;
  return { room, credential: token, created: true };
}

function resolveCredential(token) {
  if (!token || typeof token !== 'string') return null;
  return credentials.get(token) || null;
}

/**
 * Resolve an AI Bearer for an authenticated call: sweeps the credential's room first (an
 * agent idle past the TTL is expired and its credential revoked, so this returns null),
 * then records the call as activity.
 */
function authenticate(token) {
  const binding = resolveCredential(token);
  if (!binding) return null;
  const room = getRoom(binding.room_id);
  const live = resolveCredential(token);
  if (live && room) touch(room, 'ai', live.agent_id);
  return live;
}

function hasHuman(room, handle) {
  return room.roster.has(rosterKey('human', handle));
}

function hasAi(room, agentId) {
  return room.roster.has(rosterKey('ai', agentId));
}

/**
 * The one removal path, shared by leave and presence expiry: revoke an AI's credential,
 * drop the roster entry and (on leave) stop awaiting them. Returns true if they were present.
 */
function removeParty(room, party, id, { dropTurn = true } = {}) {
  const key = rosterKey(party, id);
  const entry = room.roster.get(key);
  if (!entry) return false;
  if (entry.credential) credentials.delete(entry.credential);
  room.roster.delete(key);
  // On expiry the awaited id instead follows pruneAwaiting's grace rule.
  if (dropTurn) dropAwaiting(room, entry.id);
  return true;
}

/**
 * Explicit leave: off the roster and no longer a member (ends `message` notifications and
 * inbox unread), and no longer awaited. Someone who is neither present nor a member gets
 * false and changes nothing. Only a real leave can delete a room, and only when it leaves
 * nobody present and no kept members (see maybeGc). Expiry never deletes a room.
 */
function leaveParty(room, party, id) {
  const members = membersOf(room);
  const key = rosterKey(party, id);
  if (!room.roster.has(key) && !members[key]) return false;
  delete members[key];
  if (!removeParty(room, party, id)) dropAwaiting(room, id); // an expired member leaving
  maybeGc(room);
  return true;
}

function leaveHuman(room, handle) {
  return leaveParty(room, 'human', handle);
}

function leaveAi(room, agentId) {
  return leaveParty(room, 'ai', agentId);
}

/** Delete a room with nobody present and no kept members. The lobby is never deleted. */
function maybeGc(room) {
  if (room.id === OPEN_WELCOME_ROOM_ID) return false;
  if (room.roster.size > 0 || Object.keys(membersOf(room)).length > 0) return false;
  openRooms.delete(room.id);
  return true;
}

function clearAll() {
  openRooms.clear();
  credentials.clear();
  presenceEpoch = now();
  ensureWelcomeLobby();
}

ensureWelcomeLobby();
console.log(describePresenceTtl());

module.exports = {
  MAX_PARTIES,
  OPEN_WELCOME_ROOM_ID,
  OPEN_WELCOME_TITLE,
  DEFAULT_PRESENCE_TTL_MS,
  MIN_PRESENCE_TTL_MS,
  presenceTtlMs,
  describePresenceTtl,
  takeDirty,
  isMember,
  createRoom,
  listRooms,
  updateRoom,
  VISIBILITIES,
  addMessage,
  lastRoomOf,
  onMessage,
  setTurn,
  turnOf,
  markSeen,
  inbox,
  TURN_STATES,
  getRoom,
  listRoster,
  joinHuman,
  joinAi,
  resolveCredential,
  authenticate,
  touch,
  sweep,
  hasHuman,
  hasAi,
  leaveHuman,
  leaveAi,
  ensureWelcomeLobby,
  clearAll,
  _setClock,
  _openRooms: openRooms,
  _credentials: credentials,
};
