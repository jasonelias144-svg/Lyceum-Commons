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
