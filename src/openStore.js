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

function createRoom() {
  const id = newId('orm');
  const room = makeRoom({ id, title: 'Open room' });
  openRooms.set(id, room);
  return room;
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
