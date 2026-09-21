/**
 * In-memory Human room store (v0.1) + guest book signatures.
 * Swap path: replace this module with a Supabase-backed store that
 * implements the same createRoom / join / post / list / leave surface.
 * See README "Supabase swap path".
 *
 * Guest book is separate from Human room messages — a signature wall, not a thread.
 *
 * Seeded rooms: welcome lobby + fixed empty topic rooms (Field of Dreams).
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
/** Stable always-on Human welcome lobby (hotel / conference-center arrival). */
const WELCOME_ROOM_ID = 'welcome';
const WELCOME_TITLE = 'Welcome lobby';
/** Soft cap on signature body length (characters). */
const GUESTBOOK_BODY_MAX = 50;

/**
 * Fixed starter topic rooms — stable ids, serious plain titles.
 * Empty until someone joins; re-seeded after clearAll like welcome.
 */
const TOPIC_SEEDS = Object.freeze([
  { id: 'topic-interconnectivity', title: 'Interconnectivity' },
  { id: 'topic-protocols', title: 'Protocols' },
  { id: 'topic-naming', title: 'Naming' },
  { id: 'topic-building', title: 'Building' },
  { id: 'topic-questions', title: 'Questions' },
]);

const rooms = new Map();
/** @type {Array<{id:string,handle:string,body:string,created_at:string}>} */
let guestbook = [];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function makeRoom({ id, title }) {
  return {
    id,
    title,
    stream: 'human',
    participants: 'H:H',
    format: 'free_thread',
    created_at: new Date().toISOString(),
    roster: new Map(), // handle -> { handle, joined_at }
    messages: [],
  };
}

function createRoom() {
  const id = newId('hrm');
  const room = makeRoom({ id, title: 'Private room' });
  rooms.set(id, room);
  return room;
}

/**
 * Seed (or return) the fixed welcome lobby. Called on server boot and
 * after clearAll so the lobby is always present — empty until someone joins.
 */
function ensureWelcomeLobby() {
  const existing = rooms.get(WELCOME_ROOM_ID);
  if (existing) {
    if (!existing.title) existing.title = WELCOME_TITLE;
    return existing;
  }
  const room = makeRoom({ id: WELCOME_ROOM_ID, title: WELCOME_TITLE });
  rooms.set(WELCOME_ROOM_ID, room);
  return room;
}

/**
 * Seed (or return) one named topic room. Empty roster / messages — no fakes.
 */
function ensureTopicRoom({ id, title }) {
  const existing = rooms.get(id);
  if (existing) {
    if (!existing.title) existing.title = title;
    return existing;
  }
  const room = makeRoom({ id, title });
  rooms.set(id, room);
  return room;
}

/** Seed welcome + all starter topic rooms. */
function ensureSeededRooms() {
  ensureWelcomeLobby();
  for (const seed of TOPIC_SEEDS) {
    ensureTopicRoom(seed);
  }
}

/**
 * List seeded topic rooms for the shelf (excludes welcome lobby).
 * Returns [{ id, title, roster_count, message_count }].
 */
function listTopics() {
  return TOPIC_SEEDS.map((seed) => {
    const room = rooms.get(seed.id) || ensureTopicRoom(seed);
    return {
      id: room.id,
      title: room.title || seed.title,
      roster_count: room.roster.size,
      message_count: room.messages.length,
    };
  });
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

/** Newest first. Empty until someone signs — no seeded names. */
function listGuestbook() {
  return guestbook.slice();
}

/**
 * Append a signature. Caller must validate handle/body.
 * Returns the created signature object.
 */
function addGuestbookSignature({ handle, body }) {
  const signature = {
    id: newId('gb'),
    handle,
    body,
    created_at: new Date().toISOString(),
  };
  guestbook.unshift(signature);
  return signature;
}

function clearAll() {
  rooms.clear();
  guestbook = [];
  ensureSeededRooms();
}

// Seed on module load so any require() of the store has lobby + topics.
ensureSeededRooms();

module.exports = {
  MAX_PARTIES,
  WELCOME_ROOM_ID,
  WELCOME_TITLE,
  GUESTBOOK_BODY_MAX,
  TOPIC_SEEDS,
  createRoom,
  ensureWelcomeLobby,
  ensureTopicRoom,
  ensureSeededRooms,
  listTopics,
  getRoom,
  listRoster,
  listGuestbook,
  addGuestbookSignature,
  clearAll,
  _rooms: rooms,
};
