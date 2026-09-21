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
 * Room format: welcome → live (200); topic roots + private create → board (4000);
 * branches inherit parent format. Cycle A: fixed at create/seed.
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
/** Stable always-on Human welcome lobby (hotel / conference-center arrival). */
const WELCOME_ROOM_ID = 'welcome';
const WELCOME_TITLE = 'Welcome lobby';
/** Soft cap on signature body length (characters). */
const GUESTBOOK_BODY_MAX = 50;
const {
  FORMAT_LIVE,
  FORMAT_BOARD,
  BODY_CAP_LIVE,
  BODY_CAP_BOARD,
  normalizeFormat,
  bodyCapForFormat,
} = require('./humanFormat');
/** Orientation author for seeded topic prompts — not a rostered guest. */
const HOST_HANDLE = 'Host';

/**
 * Fixed root topic rooms — stable ids, serious plain titles, distinct subjects.
 * Each root gets one Host orientation message (with opening questions).
 * Roster stays empty until a stranger joins. Re-seeded after clearAll.
 */
const { TOPIC_SEEDS } = require('./storeSeeds');

const rooms = new Map();
/** @type {Array<{id:string,handle:string,body:string,created_at:string}>} */
let guestbook = [];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function makeRoom({ id, title, parent_id = null, merged_into = null, format = FORMAT_BOARD }) {
  return {
    id,
    title,
    parent_id,
    merged_into,
    stream: 'human',
    participants: 'H:H',
    format: normalizeFormat(format, FORMAT_BOARD),
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

function createRoom({ format } = {}) {
  const id = newId('hrm');
  const room = makeRoom({
    id,
    title: 'Private room',
    parent_id: null,
    format: normalizeFormat(format, FORMAT_BOARD),
  });
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
  const room = makeRoom({
    id,
    title: branchTitle,
    parent_id: parent.id,
    format: normalizeFormat(parent.format, FORMAT_BOARD),
  });
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
    existing.format = FORMAT_LIVE;
    return existing;
  }
  const room = makeRoom({
    id: WELCOME_ROOM_ID,
    title: WELCOME_TITLE,
    parent_id: null,
    format: FORMAT_LIVE,
  });
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
    existing.format = FORMAT_BOARD;
    if (existing.messages.length === 0 && host_body) {
      existing.messages.push(hostOrientationMessage(id, host_body, { stable: true }));
    }
    return existing;
  }
  const room = makeRoom({ id, title, parent_id: null, format: FORMAT_BOARD });
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
      format: room.format || FORMAT_BOARD,
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
  FORMAT_LIVE,
  FORMAT_BOARD,
  BODY_CAP_LIVE,
  BODY_CAP_BOARD,
  HOST_HANDLE,
  TOPIC_SEEDS,
  ROOT_TOPIC_IDS,
  isRootTopic,
  normalizeFormat,
  bodyCapForFormat,
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
