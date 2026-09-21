/**
 * In-memory Human room store (v0.1).
 * Swap path: replace this module with a Supabase-backed store that
 * implements the same createRoom / join / post / list / leave surface.
 * See README "Supabase swap path".
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
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
}

module.exports = {
  MAX_PARTIES,
  createRoom,
  getRoom,
  listRoster,
  clearAll,
  _rooms: rooms,
};
