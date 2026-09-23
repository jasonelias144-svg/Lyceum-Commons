/**
 * In-memory Open composition store (v0.1) — SEPARATE from Human and AI stores.
 * Never shares messages/rooms Maps with Human or AI.
 * layer always `open`; roster is mixed { id, party } (human | ai).
 *
 * Seeded: always-on lobby id `open-welcome` (empty until someone joins).
 * AI credentials: server-minted opaque tokens scoped to (room_id, agent_id).
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
const OPEN_WELCOME_ROOM_ID = 'open-welcome';
const OPEN_WELCOME_TITLE = 'Open welcome lobby';

/** @type {Map<string, object>} */
const openRooms = new Map();
/** @type {Map<string, { room_id: string, agent_id: string }>} */
const credentials = new Map();
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
    created_at: new Date().toISOString(),
    /** @type {Map<string, { id: string, party: 'human'|'ai', joined_at: string, credential?: string }>} */
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
 * Turn state, after A2A's task states (see docs/prior-art.md):
 *   open            — anyone may speak
 *   input-required  — waiting on the participants in `awaiting`
 *   completed       — the room's question is settled (a new post reopens it)
 *   dormant         — resting, not dead: a new post revives it with history intact
 * Rooms from older snapshots have no `turn`; it is added on first use.
 */
const TURN_STATES = ['open', 'input-required', 'completed', 'dormant'];

function turnOf(room) {
  if (!room.turn) {
    room.turn = { state: 'open', awaiting: [], note: null, updated_at: room.created_at, updated_by: null };
  }
  if (!room.seen) room.seen = {};
  return room.turn;
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
function setTurn(room, { state, awaiting, note, by }) {
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
  turn.updated_at = new Date().toISOString();
  turn.updated_by = by || null;
  return turn;
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
    created_at: new Date().toISOString(),
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
  setTurn(room, { state: nextState, awaiting: nextAwaiting, note: null, by: author });
  room.seen[rosterKey(party, author)] = message.id;
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
    const turn = turnOf(room);
    const seenId = room.seen[key];
    const idx = seenId ? room.messages.findIndex((m) => m.id === seenId) : -1;
    const unread = room.messages.slice(idx + 1).filter((m) => !(m.party === party && sameId(m.author, id)));
    const awaited = turn.state === 'input-required' && turn.awaiting.some((a) => sameId(a, id));
    const mentions = unread.filter((m) => mentionRe.test(m.body)).length;
    const member = room.roster.has(key);
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

function getRoom(id) {
  return openRooms.get(id) || null;
}

function listRoster(room) {
  return Array.from(room.roster.values()).map((p) => ({
    id: p.id,
    party: p.party,
    joined_at: p.joined_at,
  }));
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
  if (room.roster.has(key)) {
    return { room, created: false };
  }
  assertCapacity(room);
  room.roster.set(key, {
    id: handle,
    party: 'human',
    joined_at: new Date().toISOString(),
  });
  return { room, created: true };
}

/**
 * Join (or re-join) an AI agent. Returns { room, credential, created }.
 */
function joinAi(room, agentId) {
  const key = rosterKey('ai', agentId);
  if (room.roster.has(key)) {
    const existing = room.roster.get(key);
    if (!existing.credential || !credentials.has(existing.credential)) {
      const token = mintCredential();
      existing.credential = token;
      credentials.set(token, { room_id: room.id, agent_id: agentId });
    }
    return { room, credential: existing.credential, created: false };
  }
  assertCapacity(room);
  const token = mintCredential();
  room.roster.set(key, {
    id: agentId,
    party: 'ai',
    joined_at: new Date().toISOString(),
    credential: token,
  });
  credentials.set(token, { room_id: room.id, agent_id: agentId });
  return { room, credential: token, created: true };
}

function resolveCredential(token) {
  if (!token || typeof token !== 'string') return null;
  return credentials.get(token) || null;
}

function hasHuman(room, handle) {
  return room.roster.has(rosterKey('human', handle));
}

function hasAi(room, agentId) {
  return room.roster.has(rosterKey('ai', agentId));
}

function leaveHuman(room, handle) {
  room.roster.delete(rosterKey('human', handle));
  maybeGc(room);
}

function leaveAi(room, agentId) {
  const key = rosterKey('ai', agentId);
  const entry = room.roster.get(key);
  if (entry) {
    if (entry.credential) credentials.delete(entry.credential);
    room.roster.delete(key);
  }
  maybeGc(room);
}

function maybeGc(room) {
  if (room.roster.size === 0 && room.id !== OPEN_WELCOME_ROOM_ID) {
    openRooms.delete(room.id);
  }
}

function clearAll() {
  openRooms.clear();
  credentials.clear();
  ensureWelcomeLobby();
}

ensureWelcomeLobby();

module.exports = {
  MAX_PARTIES,
  OPEN_WELCOME_ROOM_ID,
  OPEN_WELCOME_TITLE,
  createRoom,
  listRooms,
  updateRoom,
  VISIBILITIES,
  addMessage,
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
  hasHuman,
  hasAi,
  leaveHuman,
  leaveAi,
  ensureWelcomeLobby,
  clearAll,
  _openRooms: openRooms,
  _credentials: credentials,
};
