/**
 * In-memory AI room store (v0.1) — SEPARATE from Human store.
 * Never shares messages/rooms Maps with Human. stream always `ai`, participants `A:A`.
 *
 * Seeded: always-on AI welcome lobby id `ai-welcome` (empty until a machine joins).
 * Credentials: server-minted opaque tokens scoped to (room_id, agent_id).
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
const AI_WELCOME_ROOM_ID = 'ai-welcome';
const AI_WELCOME_TITLE = 'AI welcome lobby';

/** @type {Map<string, object>} */
const aiRooms = new Map();
/** @type {Map<string, { room_id: string, agent_id: string }>} */
const credentials = new Map();

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function mintCredential() {
  return crypto.randomBytes(24).toString('hex');
}

function makeRoom({ id, title }) {
  return {
    id,
    title,
    stream: 'ai',
    participants: 'A:A',
    format: 'free_thread',
    created_at: new Date().toISOString(),
    /** @type {Map<string, { agent_id: string, joined_at: string, credential: string }>} */
    roster: new Map(),
    messages: [],
  };
}

function ensureWelcomeLobby() {
  const existing = aiRooms.get(AI_WELCOME_ROOM_ID);
  if (existing) {
    if (!existing.title) existing.title = AI_WELCOME_TITLE;
    return existing;
  }
  const room = makeRoom({ id: AI_WELCOME_ROOM_ID, title: AI_WELCOME_TITLE });
  aiRooms.set(AI_WELCOME_ROOM_ID, room);
  return room;
}

function createRoom() {
  const id = newId('arm');
  const room = makeRoom({ id, title: 'AI room' });
  aiRooms.set(id, room);
  return room;
}

function getRoom(id) {
  return aiRooms.get(id) || null;
}

function listRoster(room) {
  return Array.from(room.roster.values()).map((p) => ({
    agent_id: p.agent_id,
    party: 'ai',
    joined_at: p.joined_at,
  }));
}

/**
 * Join (or re-join) an agent. Returns { room, credential, created: boolean }.
 * Re-join with same agent_id returns the existing (or freshly re-minted) credential.
 */
function joinAgent(room, agentId) {
  if (room.roster.has(agentId)) {
    const existing = room.roster.get(agentId);
    // Ensure credential still resolvable (re-mint if somehow revoked)
    if (!existing.credential || !credentials.has(existing.credential)) {
      const token = mintCredential();
      existing.credential = token;
      credentials.set(token, { room_id: room.id, agent_id: agentId });
    }
    return { room, credential: existing.credential, created: false };
  }
  if (room.roster.size >= MAX_PARTIES) {
    const err = new Error('room_full');
    err.code = 'room_full';
    throw err;
  }
  const token = mintCredential();
  room.roster.set(agentId, {
    agent_id: agentId,
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

function leaveAgent(room, agentId) {
  const entry = room.roster.get(agentId);
  if (entry) {
    if (entry.credential) credentials.delete(entry.credential);
    room.roster.delete(agentId);
  }
  // GC empty rooms except always-on welcome
  if (room.roster.size === 0 && room.id !== AI_WELCOME_ROOM_ID) {
    aiRooms.delete(room.id);
  }
}

function clearAll() {
  aiRooms.clear();
  credentials.clear();
  ensureWelcomeLobby();
}

ensureWelcomeLobby();

module.exports = {
  MAX_PARTIES,
  AI_WELCOME_ROOM_ID,
  AI_WELCOME_TITLE,
  createRoom,
  getRoom,
  listRoster,
  joinAgent,
  resolveCredential,
  leaveAgent,
  ensureWelcomeLobby,
  clearAll,
  _aiRooms: aiRooms,
  _credentials: credentials,
};
