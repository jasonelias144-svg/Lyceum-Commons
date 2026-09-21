/**
 * In-memory Human room store (v0.1) + guest book signatures.
 * Swap path: replace this module with a Supabase-backed store that
 * implements the same createRoom / join / post / list / leave / branch / merge surface.
 * See README "Supabase swap path".
 *
 * Guest book is separate from Human room messages — a signature wall, not a thread.
 *
 * Seeded rooms: welcome lobby (empty) + ~12 root topic rooms with one Host
 * orientation each (Field of Dreams). Rooms may branch via parent_id.
 * No fake guests, no fabricated back-and-forth.
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
 * Fixed root topic rooms — stable ids, serious plain titles, distinct subjects.
 * Each root gets one Host orientation message (with opening questions).
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
  {
    id: 'topic-human-stream',
    title: 'Human stream',
    host_body:
      'This room is for the Human stream — people-only floors, handles as declaration, and what “H:H” must protect.\n\nOpening questions:\n• What belongs only on the Human stream?\n• How should a stranger prove presence without proving identity?\n• When does a Human room need a door the AI stream cannot open?',
  },
  {
    id: 'topic-ai-stream',
    title: 'AI stream',
    host_body:
      'This room is for the AI stream — machines joining through an API, not through a fake human seat.\n\nOpening questions:\n• What must an AI party declare before it may speak?\n• How do we keep AI honest when the Human stream stays separate?\n• What would a good first AI room refuse to pretend?',
  },
  {
    id: 'topic-open-composition',
    title: 'Open composition',
    host_body:
      'This room is for Open composition — where Human and AI streams meet without blending into one anonymous chat.\n\nOpening questions:\n• What does “meet” mean if streams stay distinct?\n• Who sets the rules when both parties are present?\n• What should Open never collapse into?',
  },
  {
    id: 'topic-design-face',
    title: 'Design / face',
    host_body:
      'This room is for design and face — the atrium, quiet chrome, and how the site greets a stranger before any room.\n\nOpening questions:\n• What should the face promise, and what should it withhold?\n• How quiet can a door be and still be found?\n• Where does ornament help, and where does it sell?',
  },
  {
    id: 'topic-commons-funding',
    title: 'Commons & funding',
    host_body:
      'This room is for the commons and funding — keeping the floor free without a shop in the product surface.\n\nOpening questions:\n• What does “free to use” require behind the scenes?\n• How do we fund care without turning rooms into inventory?\n• What would you refuse to monetize here?',
  },
  {
    id: 'topic-learning',
    title: 'Learning',
    host_body:
      'This room is for learning — how strangers teach each other on an empty floor, and what the rooms remember.\n\nOpening questions:\n• What is worth learning in public?\n• How do we leave trails without seeding fake history?\n• What would help the next person who arrives alone?',
  },
  {
    id: 'topic-field-notes',
    title: 'Field notes',
    host_body:
      'This room is for field notes — observations from building and inhabiting Lyceum Commons, without performative chatter.\n\nOpening questions:\n• What did you notice that the docs do not say?\n• Which empty room surprised you?\n• What note would you leave for the next builder?',
  },
]);

const rooms = new Map();
/** @type {Array<{id:string,handle:string,body:string,created_at:string}>} */
let guestbook = [];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function makeRoom({ id, title, parent_id = null, merged_into = null }) {
  return {
    id,
    title,
    parent_id,
    merged_into,
    stream: 'human',
    participants: 'H:H',
    format: 'free_thread',
    created_at: new Date().toISOString(),
    roster: new Map(),
    messages: [],
    /** @type {Array<{at:string,into:string,from:string,moved:number}>} */
    merge_history: [],
  };
}

/** Host / system message. Seeded orientations may use stable:true (once per room). Merge/branch notices must be unique for ?after= pagination. */
function hostOrientationMessage(roomId, body, { stable = false } = {}) {
  const id = stable
    ? `msg_host_${roomId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`
    : `msg_host_${crypto.randomBytes(6).toString('hex')}`;
  return {
    id,
    room_id: roomId,
    author: HOST_HANDLE,
    party: 'human',
    body,
    created_at: new Date().toISOString(),
  };
}

const ROOT_TOPIC_IDS = new Set(TOPIC_SEEDS.map((s) => s.id));

function isRootTopic(id) {
  return ROOT_TOPIC_IDS.has(id);
}

function createRoom() {
  const id = newId('hrm');
  const room = makeRoom({ id, title: 'Private room', parent_id: null });
  rooms.set(id, room);
  return room;
}

function branchRoom(parent, { title } = {}) {
  if (!parent) throw new Error('parent required');
  const parentTitle = parent.title || parent.id;
  const branchTitle =
    typeof title === 'string' && title.trim()
      ? title.trim().slice(0, 80)
      : `Branch of ${parentTitle}`;
  const id = newId('hrm');
  const room = makeRoom({ id, title: branchTitle, parent_id: parent.id });
  room.messages.push(
    hostOrientationMessage(
      id,
      `Branched from ${parentTitle}. This floor starts empty — continue the thread here if the parent room grew too wide.`
    )
  );
  rooms.set(id, room);
  return room;
}

function resolveMergeDest(target) {
  let dest = target;
  const seen = new Set();
  while (dest.merged_into) {
    if (seen.has(dest.id)) break;
    seen.add(dest.id);
    const next = rooms.get(dest.merged_into);
    if (!next) break;
    dest = next;
  }
  return dest;
}

/** Structural merge policy (no mutation). Throws err.code for protocol mapping. */
function assertMergeAllowed(source, target) {
  if (!source || !target) throw new Error('source and target required');
  if (source.id === target.id) {
    const err = new Error('cannot_merge_self');
    err.code = 'cannot_merge_self';
    throw err;
  }
  if (source.id === WELCOME_ROOM_ID) {
    const err = new Error('cannot_merge_welcome');
    err.code = 'cannot_merge_welcome';
    throw err;
  }
  if (isRootTopic(source.id)) {
    const err = new Error('cannot_merge_root');
    err.code = 'cannot_merge_root';
    throw err;
  }
  if (source.merged_into) {
    const err = new Error('already_merged');
    err.code = 'already_merged';
    throw err;
  }
  const dest = resolveMergeDest(target);
  if (dest.id === source.id) {
    const err = new Error('cannot_merge_self');
    err.code = 'cannot_merge_self';
    throw err;
  }
  if (dest.id === WELCOME_ROOM_ID) {
    const err = new Error('cannot_merge_into_welcome');
    err.code = 'cannot_merge_into_welcome';
    throw err;
  }
  return dest;
}

function mergeRooms(source, target) {
  const dest = assertMergeAllowed(source, target);

  const incoming = source.messages
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const existingIds = new Set(dest.messages.map((m) => m.id));
  let moved = 0;
  for (const msg of incoming) {
    if (existingIds.has(msg.id)) continue;
    dest.messages.push({
      ...msg,
      room_id: dest.id,
      id: msg.id.startsWith('msg_merged_') ? msg.id : `msg_merged_${msg.id}`,
    });
    existingIds.add(msg.id);
    moved += 1;
  }
  dest.messages.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const at = new Date().toISOString();
  const edge = { at, into: dest.id, from: source.id, moved };
  dest.merge_history = dest.merge_history || [];
  dest.merge_history.push(edge);
  source.merge_history = source.merge_history || [];
  source.merge_history.push(edge);

  source.merged_into = dest.id;
  source.roster.clear();
  source.messages = [
    hostOrientationMessage(
      source.id,
      `This room was merged into ${dest.title || dest.id}. The thread continues there.`
    ),
  ];

  dest.messages.push(
    hostOrientationMessage(
      dest.id,
      `Merged in discussion from ${source.title || source.id} (${moved} message${moved === 1 ? '' : 's'}).`
    )
  );

  return { source, target: dest, moved };
}

function ensureWelcomeLobby() {
  const existing = rooms.get(WELCOME_ROOM_ID);
  if (existing) {
    if (!existing.title) existing.title = WELCOME_TITLE;
    if (existing.parent_id === undefined) existing.parent_id = null;
    if (existing.merged_into === undefined) existing.merged_into = null;
    if (!existing.merge_history) existing.merge_history = [];
    return existing;
  }
  const room = makeRoom({ id: WELCOME_ROOM_ID, title: WELCOME_TITLE, parent_id: null });
  rooms.set(WELCOME_ROOM_ID, room);
  return room;
}

function ensureTopicRoom({ id, title, host_body }) {
  const existing = rooms.get(id);
  if (existing) {
    if (!existing.title) existing.title = title;
    if (existing.parent_id === undefined) existing.parent_id = null;
    if (existing.merged_into === undefined) existing.merged_into = null;
    if (!existing.merge_history) existing.merge_history = [];
    if (existing.messages.length === 0 && host_body) {
      existing.messages.push(hostOrientationMessage(id, host_body, { stable: true }));
    }
    return existing;
  }
  const room = makeRoom({ id, title, parent_id: null });
  if (host_body) {
    room.messages.push(hostOrientationMessage(id, host_body, { stable: true }));
  }
  rooms.set(id, room);
  return room;
}

function ensureSeededRooms() {
  ensureWelcomeLobby();
  for (const seed of TOPIC_SEEDS) {
    ensureTopicRoom(seed);
  }
}

function listTopics() {
  return TOPIC_SEEDS.map((seed) => {
    const room = rooms.get(seed.id) || ensureTopicRoom(seed);
    return {
      id: room.id,
      title: room.title || seed.title,
      roster_count: room.roster.size,
      message_count: room.messages.length,
      parent_id: room.parent_id ?? null,
      merged_into: room.merged_into ?? null,
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

function listGuestbook() {
  return guestbook.slice();
}

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

ensureSeededRooms();

module.exports = {
  MAX_PARTIES,
  WELCOME_ROOM_ID,
  WELCOME_TITLE,
  GUESTBOOK_BODY_MAX,
  HOST_HANDLE,
  TOPIC_SEEDS,
  ROOT_TOPIC_IDS,
  isRootTopic,
  createRoom,
  branchRoom,
  mergeRooms,
  assertMergeAllowed,
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
