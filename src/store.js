/**
 * In-memory Human room store (v0.1) + guest book signatures.
 * Swap path: replace this module with a Supabase-backed store that
 * implements the same createRoom / join / post / list / leave surface.
 * See README "Supabase swap path".
 *
 * Guest book is separate from Human room messages — a signature wall, not a thread.
 *
 * Seeded rooms: welcome lobby (empty) + topic rooms with one Host orientation
 * message each (Field of Dreams). No fake guests, no fabricated back-and-forth.
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
/** Stable always-on Human welcome lobby (hotel / conference-center arrival). */
const WELCOME_ROOM_ID = 'welcome';
const WELCOME_TITLE = 'Welcome lobby';
/** Soft cap on signature body length (characters). */
const GUESTBOOK_BODY_MAX = 50;
/** Orientation author for seeded topic prompts — not a rostered guest. */
const HOST_HANDLE = 'Host';

/**
 * Fixed starter topic rooms — stable ids, serious plain titles.
 * Each gets one Host orientation message (with opening questions).
 * Roster stays empty until a stranger joins. Re-seeded after clearAll.
 */
const TOPIC_SEEDS = Object.freeze([
  {
    id: 'topic-interconnectivity',
    title: 'Interconnectivity',
    host_body:
      'This room is for interconnectivity — how separate rooms, streams, and people meet without collapsing into one pile.\n\nOpening questions:\n• What should stay separate, and what should connect?\n• When does a bridge help, and when does it flatten?\n• What would you want two strangers to share first?',
  },
  {
    id: 'topic-protocols',
    title: 'Protocols',
    host_body:
      'This room is for protocols — the small agreements that let strangers share a floor without chaos.\n\nOpening questions:\n• What is the minimum protocol a room needs?\n• What should be declared (party, handle, intent) before posting?\n• Where have you seen a protocol protect presence rather than gatekeep it?',
  },
  {
    id: 'topic-naming',
    title: 'Naming',
    host_body:
      'This room is for naming — what we call doors, rooms, parties, and the work itself.\n\nOpening questions:\n• What does a good name make possible?\n• When is a plain title better than a clever one?\n• What would you rename here, and why?',
  },
  {
    id: 'topic-building',
    title: 'Building',
    host_body:
      'This room is for building — making rooms, tools, and habits that hold people without pretending they are already full.\n\nOpening questions:\n• What is worth building empty first?\n• How do you know a structure is ready for strangers?\n• What would you add next, and what would you refuse?',
  },
  {
    id: 'topic-questions',
    title: 'Questions',
    host_body:
      'This room is for questions — the ones that open a floor rather than close it.\n\nOpening questions:\n• What question brought you here?\n• Which questions deserve a room of their own?\n• What is one question you wish more people would ask aloud?',
  },
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

function hostOrientationMessage(roomId, body) {
  return {
    id: `msg_host_${roomId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    room_id: roomId,
    author: HOST_HANDLE,
    party: 'human',
    body,
    created_at: new Date().toISOString(),
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
 * No Host spam here; lobby copy lives in the /human UI.
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
 * Seed (or return) one named topic room.
 * Roster empty; exactly one Host orientation message (no fake guests).
 */
function ensureTopicRoom({ id, title, host_body }) {
  const existing = rooms.get(id);
  if (existing) {
    if (!existing.title) existing.title = title;
    // Repair missing Host seed without inventing guest chatter.
    if (existing.messages.length === 0 && host_body) {
      existing.messages.push(hostOrientationMessage(id, host_body));
    }
    return existing;
  }
  const room = makeRoom({ id, title });
  if (host_body) {
    room.messages.push(hostOrientationMessage(id, host_body));
  }
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
  HOST_HANDLE,
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
