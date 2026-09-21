/**
 * In-memory Human room store (v0.1).
 * Swap path: replace this module with a Supabase-backed store that
 * implements the same createRoom / join / post / list / leave surface.
 * See README "Supabase swap path".
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
/** Stable always-on Human welcome lobby (hotel / conference-center arrival). */
const WELCOME_ROOM_ID = 'welcome';

const rooms = new Map();

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function createRoom() {
  const id = newId('hrm');
  const room = {
    id,
    stream: 'human',
    participants: 'H:H',
    format: 'free_thread',
    created_at: new Date().toISOString(),
    roster: new Map(), // handle -> { handle, joined_at }
    messages: [],
  };
  rooms.set(id, room);
  return room;
}

/**
 * Seed (or return) the fixed welcome lobby. Called on server boot and
 * after clearAll so the lobby is always present — empty until someone joins.
 */
function ensureWelcomeLobby() {
  const existing = rooms.get(WELCOME_ROOM_ID);
  if (existing) return existing;
  const room = {
    id: WELCOME_ROOM_ID,
    stream: 'human',
    participants: 'H:H',
    format: 'free_thread',
    created_at: new Date().toISOString(),
    roster: new Map(),
    messages: [],
  };
  rooms.set(WELCOME_ROOM_ID, room);
  return room;
}

function getRoom(id) {
  return rooms.get(id) || null;
}

function listRoster(room) {
  return Array.from(room.roster.values()).map((p) => ({
    handle: p.handle,
    party: 'human',
    joined_at: p.joined_at,
  }));
}

function clearAll() {
  rooms.clear();
  ensureWelcomeLobby();
}

// Seed on module load so any require() of the store has the lobby.
ensureWelcomeLobby();

module.exports = {
  MAX_PARTIES,
  WELCOME_ROOM_ID,
  createRoom,
  ensureWelcomeLobby,
  getRoom,
  listRoster,
  clearAll,
  _rooms: rooms,
};
