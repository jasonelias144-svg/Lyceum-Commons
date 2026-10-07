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
 * Room format: welcome → live (200); topic roots + unlisted create → board (4000);
 * branches inherit parent format. Cycle A: fixed at create/seed.
 *
 * Guest identity (same rules as Open, logic shared through guestIdentity.js, data kept here and
 * nowhere else). Membership (room.members: { owner, last_active }) is separate from presence
 * (room.roster): seats idle past HUMAN_PRESENCE_TTL_MS (default 10 minutes, matching Open) drop
 * off the roster and free a capacity slot, while the key keeps the name for 30 days. Human guest
 * keys live in this store's own registry. Unclaimed seats from before guest keys count as away
 * at once on restore; owned seats get one fresh presence TTL from boot (same as Open), then
 * drop off the roster so a restart never keeps stale seats occupied forever.
 */
const crypto = require('crypto');
const { protocolError } = require('./errors');
const guestIdentity = require('./guestIdentity');

const {
  nameKey,
  nameAllowed,
  releaseDue,
  nameTakenError,
  assertNotHeldByOther,
  assertClaimable,
  assertUnderNameCap,
} = guestIdentity;

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

/** Injectable clock for guest-name bookkeeping (tests replace it so nothing has to sleep). */
let clock = () => Date.now();

function nowIso() {
  return new Date(clock()).toISOString();
}

/** Replace the clock; call with no argument to restore Date.now. */
function _setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

/** The Human stream's own guest registry (sha256 of each key → guest record). */
const guestRegistry = guestIdentity.createGuestRegistry({ newId, nowIso });

/** The Human guest id for a key, or null for a missing, malformed or unknown key. */
function resolveGuest(key) {
  return guestRegistry.resolve(key);
}

/** Default presence TTL matches Open (OPEN_PRESENCE_TTL_MS default). 0 turns expiry off. */
const DEFAULT_PRESENCE_TTL_MS = 10 * 60 * 1000;
const MIN_PRESENCE_TTL_MS = 30 * 1000;
const ttlCache = { raw: undefined, value: DEFAULT_PRESENCE_TTL_MS };

/**
 * How long a Human seat may sit idle before it drops off the roster (HUMAN_PRESENCE_TTL_MS).
 * Same shape as Open's presenceTtlMs: whole numbers only, below 30s raised to 30s, 0 turns off.
 */
function presenceTtlMs() {
  const raw = process.env.HUMAN_PRESENCE_TTL_MS;
  if (raw === ttlCache.raw) return ttlCache.value;
  let value = DEFAULT_PRESENCE_TTL_MS;
  if (raw !== undefined && raw !== '') {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      console.warn(`HUMAN_PRESENCE_TTL_MS=${JSON.stringify(raw)} is not a whole number of ms; using ${DEFAULT_PRESENCE_TTL_MS}.`);
    } else {
      value = Number(raw);
      if (value > 0 && value < MIN_PRESENCE_TTL_MS) {
        console.warn(`HUMAN_PRESENCE_TTL_MS=${raw} is below the ${MIN_PRESENCE_TTL_MS} ms minimum; using ${MIN_PRESENCE_TTL_MS}.`);
        value = MIN_PRESENCE_TTL_MS;
      }
    }
  }
  ttlCache.raw = raw;
  ttlCache.value = value;
  return value;
}

/** Presence clock start (QC H20 S-1). Owned seats use max(last_seen, epoch); ownerless go away at once. */
let presenceEpoch = Date.now();

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
    /** handle → { owner, last_active }; kept after presence expiry until leave or 30-day release. */
    members: {},
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
    title: 'Unlisted room',
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
  source.members = {};
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
    sweep(room);
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

/**
 * Membership is separate from presence (Open's model). Joining makes you a member and seats you;
 * only leave ends membership. Presence expiry takes you off the roster (frees a capacity slot)
 * but keeps the name reserved to your guest key until leave or the 30-day release.
 */
function membersOf(room) {
  if (!room.members || typeof room.members !== 'object') {
    room.members = {};
  }
  const members = room.members;
  // Promote roster-only entries (older snapshots / fixtures) that are not yet in members.
  for (const [handle, entry] of room.roster) {
    if (members[handle]) continue;
    if (entry && entry.owner) {
      members[handle] = { owner: entry.owner, last_active: entry.last_active || entry.joined_at };
    } else if (entry) {
      // Pre-guest-key seat: no owner; release clock starts at this boot.
      members[handle] = { owner: null, last_active: new Date(presenceEpoch).toISOString() };
    }
  }
  return members;
}

function hasHuman(room, handle) {
  return room.roster.has(handle);
}

function isMember(room, handle) {
  return room.roster.has(handle) || Boolean(membersOf(room)[handle]);
}

/** True when this Human guest holds `handle` in this room (present or away). */
function ownsHuman(room, handle, gid) {
  if (!gid) return false;
  const rec = membersOf(room)[handle];
  return Boolean(rec && rec.owner === gid);
}

/** The distinct exact names this Human guest holds across all Human rooms. */
function namesHeldBy(gid) {
  const names = new Set();
  if (!gid) return names;
  for (const room of rooms.values()) {
    for (const [handle, rec] of Object.entries(membersOf(room))) {
      if (rec && rec.owner === gid) names.add(handle);
    }
  }
  return names;
}

/** True when this Human guest holds the exact name in any Human room. */
function guestHolds(gid, handle) {
  for (const room of rooms.values()) {
    if (ownsHuman(room, handle, gid)) return true;
  }
  return false;
}

/** Every guest id that still holds at least one Human name. */
function heldGuestIds() {
  const held = new Set();
  for (const room of rooms.values()) {
    for (const rec of Object.values(membersOf(room))) {
      if (rec && rec.owner) held.add(rec.owner);
    }
  }
  return held;
}

/** A name that folds (nameKey) to the same thing as someone else's membership is taken. */
function assertNoLookalike(room, handle) {
  const wanted = nameKey(handle);
  for (const other of Object.keys(membersOf(room))) {
    if (other !== handle && nameKey(other) === wanted) throw nameTakenError();
  }
}

/**
 * When a seat was last seen, for presence expiry. Matches Open: owned seats get one fresh TTL
 * from this boot (max(seen, presenceEpoch)); unclaimed pre-guest seats count as away at once
 * when restored from before this boot, so nothing refreshes them into a predictable mass expiry.
 */
function lastSeenMs(entry, room) {
  const seen = Date.parse(entry.last_seen || entry.joined_at) || 0;
  if (room) {
    const rec = membersOf(room)[entry.handle];
    if (rec && typeof rec === 'object' && !rec.owner) return seen < presenceEpoch ? 0 : seen;
  }
  return Math.max(seen, presenceEpoch);
}

/** Drop idle seats off the roster (capacity); membership stays. */
function expireIdle(room) {
  membersOf(room);
  const ttl = presenceTtlMs();
  if (!ttl) return [];
  const t = clock();
  const expired = [];
  for (const [handle, entry] of Array.from(room.roster.entries())) {
    const seen = lastSeenMs(entry, room);
    // Restored entries (no last_seen, or one from before this boot) show the boot time.
    if (!entry.last_seen || Date.parse(entry.last_seen) < seen) entry.last_seen = new Date(seen).toISOString();
    if (t - seen > ttl) {
      room.roster.delete(handle);
      expired.push(handle);
    }
  }
  return expired;
}

/** Release memberships with no activity for 30 days and nobody present under the name. */
function releaseIdle(room) {
  const members = membersOf(room);
  const t = clock();
  const released = [];
  for (const [handle, rec] of Object.entries(members)) {
    if (!rec || typeof rec !== 'object' || room.roster.has(handle)) continue;
    if (!releaseDue(rec.last_active, t)) continue;
    delete members[handle];
    released.push(handle);
  }
  return released;
}

/**
 * Lazy housekeeping on every read: expire idle seats, release idle names, drop ownerless
 * legacy seats, and prune guest records that hold nothing.
 */
function sweep(room) {
  const members = membersOf(room);
  // Pre-guest-key / ownerless: drop from roster and members (claimable by first joiner).
  for (const [handle, rec] of Object.entries(members)) {
    if (rec && !rec.owner) {
      delete members[handle];
      room.roster.delete(handle);
    }
  }
  expireIdle(room);
  releaseIdle(room);
  return [];
}

/** Drop guest records that hold no names. Called from snapshot serialize (not on leave). */
function pruneGuestRecords() {
  return guestRegistry.pruneEmpty(heldGuestIds());
}

function getRoom(id) {
  const room = rooms.get(id) || null;
  if (room) sweep(room);
  return room;
}


/**
 * Shared join pre-checks for prepareJoin and joinHuman (kept in one place so they agree).
 * Returns { members, rec, present, claim, kind } where kind is 'skip' | 'charge'.
 */
function evaluateJoin(room, handle, gid = null) {
  sweep(room);
  const members = membersOf(room);
  const rec = members[handle] && typeof members[handle] === 'object' ? members[handle] : null;
  if (!rec && !nameAllowed(handle)) throw protocolError('invalid_handle');
  assertNotHeldByOther(rec, gid);
  assertNoLookalike(room, handle);
  const present = room.roster.has(handle);
  const claim = assertClaimable(rec, present);
  if (!present && !rec && room.roster.size >= MAX_PARTIES) throw protocolError('room_full');
  // Rejoining an owned-but-away name: capacity only if the room is full of *other* present seats.
  if (!present && rec && rec.owner === gid && room.roster.size >= MAX_PARTIES) {
    throw protocolError('room_full');
  }
  assertUnderNameCap(gid, rec, {
    holdsName: () => guestHolds(gid, handle),
    heldCount: () => namesHeldBy(gid).size,
  });
  // Mint, claim, or brand-new seat → charge. Owned reseat / present rejoin → free.
  const kind = !gid || claim || (!present && !rec) ? 'charge' : 'skip';
  return { members, rec, present, claim, kind };
}

/**
 * Whether a Human join would write. Returns 'skip' for an owned reseat / present rejoin
 * (do not charge). Returns 'charge' for a new guest key mint, a claim, or a brand-new seat.
 * Throws the same codes joinHuman would so they keep precedence over rate_limited.
 */
function prepareJoin(room, handle, gid = null) {
  return evaluateJoin(room, handle, gid).kind;
}

/**
 * Join (or re-join) `handle` as Human guest `gid`. Returns { room, created, guest_key }.
 * A held name answers only to its owner. Presence expiry frees a capacity slot but the name
 * stays reserved: the holder rejoins without minting a new key and without a room_full check
 * against their own reserved seat. Capacity counts present seats only.
 */
function joinHuman(room, handle, gid = null) {
  const { members, rec, present, claim } = evaluateJoin(room, handle, gid);
  let guestKey = null;
  if (!gid) ({ key: guestKey, gid } = guestRegistry.mint());
  const at = nowIso();
  if (claim) {
    // Nothing to hand over on Human (no webhooks); membership is rewritten below.
  }
  members[handle] = { owner: gid, last_active: at };
  if (present) {
    touch(room, handle);
  } else {
    room.roster.set(handle, { handle, joined_at: at, last_seen: at });
  }
  return { room, created: !present && !rec, guest_key: guestKey };
}

/** Seat the guest that branched a room in the new branch under the same name (no new name). */
function seatInBranch(room, handle, gid) {
  const at = nowIso();
  membersOf(room)[handle] = { owner: gid, last_active: at };
  room.roster.set(handle, { handle, joined_at: at, last_seen: at });
}

/** Record activity under a name (keeps the seat and the 30-day release clock). */
function touch(room, handle) {
  const at = nowIso();
  const entry = room.roster.get(handle);
  if (entry) entry.last_seen = at;
  const rec = membersOf(room)[handle];
  if (rec && typeof rec === 'object') rec.last_active = at;
  return Boolean(entry);
}

/** Explicit leave: off the roster and no longer a member (name is free). */
function leaveHuman(room, handle) {
  const members = membersOf(room);
  const was = room.roster.has(handle) || Boolean(members[handle]);
  delete members[handle];
  room.roster.delete(handle);
  return was;
}

function listRoster(room) {
  return Array.from(room.roster.values()).map((p) => ({
    handle: p.handle,
    party: 'human',
    joined_at: p.joined_at,
    last_seen: p.last_seen || p.joined_at,
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

/** Snapshot helpers (persist.js). */
function _getGuestbook() {
  return guestbook;
}

function _setGuestbook(list) {
  guestbook = Array.isArray(list) ? list : [];
}

function clearAll() {
  rooms.clear();
  guestRegistry.clear();
  guestbook = [];
  presenceEpoch = clock();
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
  sweep,
  resolveGuest,
  joinHuman,
  prepareJoin,
  seatInBranch,
  ownsHuman,
  hasHuman,
  isMember,
  touch,
  leaveHuman,
  pruneGuestRecords,
  listRoster,
  presenceTtlMs,
  DEFAULT_PRESENCE_TTL_MS,
  MIN_PRESENCE_TTL_MS,
  listGuestbook,
  addGuestbookSignature,
  clearAll,
  _rooms: rooms,
  _guests: guestRegistry.guests,
  _setClock,
  /** Tests: pretend the server booted at `ms` (default now). */
  _setPresenceEpoch(ms) {
    const was = presenceEpoch;
    presenceEpoch = ms === undefined ? clock() : ms;
    return was;
  },
  _getGuestbook,
  _setGuestbook,
};
