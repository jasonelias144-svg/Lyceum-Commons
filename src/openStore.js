/**
 * In-memory Open composition store (v0.1) — SEPARATE from Human and AI stores.
 * Never shares messages/rooms Maps with Human or AI.
 * layer always `open`; roster is mixed { id, party } (human | ai).
 *
 * Seeded: always-on lobby id `open-welcome` (empty until someone joins).
 * AI credentials: server-minted opaque tokens scoped to (room_id, agent_id).
 *
 * Presence: every roster entry carries `last_seen`, refreshed by join, post, reading
 * messages, heartbeat and any other authenticated call. Parties idle longer than the
 * presence TTL (OPEN_PRESENCE_TTL_MS, default 10 minutes, 0 turns expiry off) are
 * expired lazily whenever the room is read or changed; there are no timers.
 * Membership (room.members) is separate from presence: expiry keeps it, leave ends it.
 * Human memberships belong to a guest key (see "Guest keys" below); 30 days without any
 * activity releases one.
 */
const crypto = require('crypto');
const { protocolError } = require('./errors');

const MAX_PARTIES = 16;
/** Distinct human names one guest key may hold across all rooms (the /guests page states it). */
const MAX_NAMES_PER_GUEST = 5;
const OPEN_WELCOME_ROOM_ID = 'open-welcome';
const OPEN_WELCOME_TITLE = 'Open welcome lobby';
const DEFAULT_PRESENCE_TTL_MS = 10 * 60 * 1000;

/** Injectable clock (tests replace it so nothing has to sleep). */
let clock = () => Date.now();

function now() {
  return clock();
}

function nowIso() {
  return new Date(now()).toISOString();
}

/** Replace the clock; call with no argument to restore Date.now. */
function _setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

const MIN_PRESENCE_TTL_MS = 30 * 1000;
const ttlCache = { raw: undefined, value: DEFAULT_PRESENCE_TTL_MS };

/**
 * Presence TTL in ms from OPEN_PRESENCE_TTL_MS (read on each use, parsed once per value).
 * Only a plain integer string is accepted: 0 turns expiry off, anything below 30000 is
 * raised to 30000, and anything else (spaces, units, hex, decimals, negatives) falls back
 * to the 10-minute default with a warning.
 */
function presenceTtlMs() {
  const raw = process.env.OPEN_PRESENCE_TTL_MS;
  if (raw === ttlCache.raw) return ttlCache.value;
  let value = DEFAULT_PRESENCE_TTL_MS;
  if (raw !== undefined && raw !== '') {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      console.warn(`OPEN_PRESENCE_TTL_MS=${JSON.stringify(raw)} is not a whole number of ms; using ${DEFAULT_PRESENCE_TTL_MS}.`);
    } else {
      value = Number(raw);
      if (value > 0 && value < MIN_PRESENCE_TTL_MS) {
        console.warn(`OPEN_PRESENCE_TTL_MS=${raw} is below the ${MIN_PRESENCE_TTL_MS} ms minimum; using ${MIN_PRESENCE_TTL_MS}.`);
        value = MIN_PRESENCE_TTL_MS;
      }
    }
  }
  ttlCache.raw = raw;
  ttlCache.value = value;
  return value;
}

/** One line for the startup log. */
function describePresenceTtl() {
  const ttl = presenceTtlMs();
  return ttl ? `Open presence TTL: ${ttl} ms` : 'Open presence TTL: off (OPEN_PRESENCE_TTL_MS=0)';
}

/** Set when a sweep changes state (expiry or prune), so reads can ask for a snapshot save. */
let dirty = false;

/** Returns whether a sweep changed state since the last call, and clears the flag. */
function takeDirty() {
  const was = dirty;
  dirty = false;
  return was;
}

/**
 * Presence clock start. Reads (GET) are not written to the snapshot, so after a restart
 * everyone on a restored roster gets one fresh TTL instead of being expired at once.
 */
let presenceEpoch = Date.now();

/** @type {Map<string, object>} */
const openRooms = new Map();
/** @type {Map<string, { room_id: string, agent_id: string }>} */
const credentials = new Map();
/** Each participant's most recent room ("party:id" → room id), the default for address lines. */
const lastRooms = new Map();

/**
 * Guest keys. A human join without a key gets a fresh random key, returned once in the join
 * response and never again. The client sends it as X-Lyceum-Guest; only its sha256 is kept,
 * mapped to a guest record. `type` leaves room for other kinds of record later, and
 * `account_id` is where a member account will attach. `gid` is internal and not secret.
 */
const guests = new Map();
const GUEST_KEY_RE = /^g_[A-Za-z0-9_-]{43}$/;
const DEFAULT_GUEST_RELEASE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_GUEST_RELEASE_MS = 60 * 1000;
const releaseCache = { raw: undefined, value: DEFAULT_GUEST_RELEASE_MS };

/**
 * How long a human name may go unused before it is released: OPEN_GUEST_RELEASE_MS, default
 * 30 days (the /guests promise). Shorter values are for testing; whole numbers of at least
 * 60000 only, anything else falls back to the default with a warning.
 */
function guestReleaseMs() {
  const raw = process.env.OPEN_GUEST_RELEASE_MS;
  if (raw === releaseCache.raw) return releaseCache.value;
  let value = DEFAULT_GUEST_RELEASE_MS;
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw) && Number(raw) >= MIN_GUEST_RELEASE_MS) value = Number(raw);
    else console.warn(`OPEN_GUEST_RELEASE_MS="${raw}" is not a whole number of at least ${MIN_GUEST_RELEASE_MS}; using ${DEFAULT_GUEST_RELEASE_MS}.`);
  }
  releaseCache.raw = raw;
  releaseCache.value = value;
  return value;
}

function hashGuestKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function mintGuest() {
  const key = `g_${crypto.randomBytes(32).toString('base64url')}`;
  const record = { gid: newId('gst'), type: 'guest', created_at: nowIso(), account_id: null };
  guests.set(hashGuestKey(key), record);
  return { key, gid: record.gid };
}

/** The guest id for a key, or null for a missing, malformed or unknown key. */
function resolveGuest(key) {
  if (typeof key !== 'string' || !GUEST_KEY_RE.test(key)) return null;
  const record = guests.get(hashGuestKey(key));
  return record ? record.gid : null;
}

/**
 * Listeners for { type: 'release', room_id, owner, handle } (notify drops that owner's
 * subscriptions for the name in that room; owner null means the unclaimed ones a claim replaces).
 */
const guestListeners = [];

function onGuestEvent(fn) {
  guestListeners.push(fn);
}

function emitGuestEvent(event) {
  for (const fn of guestListeners) {
    try {
      fn(event);
    } catch (err) {
      console.error('Guest listener failed:', err);
    }
  }
}

function lastRoomOf(party, id) {
  return lastRooms.get(rosterKey(party, id)) || null;
}

/** Called after every post (notifications). A failing listener never breaks posting. */
const messageListeners = [];

function onMessage(fn) {
  messageListeners.push(fn);
}

/** Called after an explicit leave as (room, party, id). Expiry is not a leave. */
const leaveListeners = [];

function onLeave(fn) {
  leaveListeners.push(fn);
}

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
    /** 'listed' rooms appear in room lists; 'unlisted' ones only to members (link only). */
    visibility: 'listed',
    created_at: nowIso(),
    /** @type {Map<string, { id: string, party: 'human'|'ai', joined_at: string, last_seen?: string, credential?: string }>} */
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

const VISIBILITIES = ['listed', 'unlisted'];

function createRoom({ title, visibility } = {}) {
  const id = newId('orm');
  const room = makeRoom({ id, title: title || 'Open room' });
  if (visibility === 'unlisted') room.visibility = 'unlisted';
  openRooms.set(id, room);
  return room;
}

/**
 * Open rooms, lobby first, then oldest first. With a viewer ({ party, id }), unlisted
 * rooms are included only if the viewer is a member. Unlisted is not access control:
 * anyone with the room id can still join (there are no accounts yet).
 */
function listRooms(viewer) {
  const all = Array.from(openRooms.values());
  all.forEach(sweep);
  if (!viewer) return all;
  return all.filter((r) => r.visibility !== 'unlisted' || r.roster.has(rosterKey(viewer.party, viewer.id)));
}

/** Change a room's name and/or visibility. The welcome lobby always stays listed. */
function updateRoom(room, { title, visibility }) {
  if (visibility !== undefined) {
    if (!VISIBILITIES.includes(visibility)) {
      const err = new Error('invalid_visibility');
      err.code = 'invalid_visibility';
      throw err;
    }
    if (room.id !== OPEN_WELCOME_ROOM_ID) room.visibility = visibility;
  }
  if (title !== undefined && title.trim()) room.title = title.trim().slice(0, 120);
  return room;
}

/**
 * Membership is tracked apart from presence (the roster). Joining makes you a member;
 * only an explicit leave ends it. Expiry takes you off the roster (you must join again
 * to post) but keeps your membership, so `message` notifications and inbox unread keep
 * reaching you while you are away. Stored as { "party:id": record } so it snapshots as JSON:
 * AI records are `true`; human records are { owner, last_active }, where owner is the guest id
 * that holds the name (null for a membership from before guest keys, until a rejoin claims it).
 */
function membersOf(room) {
  if (!room.members || typeof room.members !== 'object') {
    // Rooms from older snapshots: everyone on the roster is a member.
    room.members = {};
    for (const key of room.roster.keys()) room.members[key] = true;
  }
  for (const key of Object.keys(room.members)) {
    if (room.members[key] === true && key.startsWith('human:')) {
      // From before guest keys: no owner yet, and the release clock starts at this boot.
      room.members[key] = { owner: null, last_active: new Date(presenceEpoch).toISOString() };
    }
  }
  return room.members;
}

/** True when this guest holds the human name in this room. */
function ownsHuman(room, handle, gid) {
  if (!gid) return false;
  const rec = membersOf(room)[rosterKey('human', handle)];
  return Boolean(rec && rec.owner === gid);
}

/** True when this owner (a guest id, or null for unclaimed) holds the exact human name in this room. */
function holdsIn(room, owner, handle) {
  const rec = membersOf(room)[rosterKey('human', handle)];
  return Boolean(rec) && (rec.owner || null) === (owner || null);
}

/** The distinct exact human names this guest holds across all rooms. */
function namesHeldBy(owner) {
  const names = new Set();
  if (!owner) return names;
  for (const room of openRooms.values()) {
    for (const [key, rec] of Object.entries(membersOf(room))) {
      if (key.startsWith('human:') && rec && rec.owner === owner) names.add(key.slice('human:'.length));
    }
  }
  return names;
}

/** True when this owner holds the exact human name in any room. */
function guestHolds(owner, handle) {
  for (const room of openRooms.values()) {
    if (holdsIn(room, owner, handle)) return true;
  }
  return false;
}

function isMember(room, party, id) {
  const key = rosterKey(party, id);
  return room.roster.has(key) || Boolean(membersOf(room)[key]);
}

/**
 * Turn state, after A2A's task states (see docs/prior-art.md):
 *   open            — anyone may speak
 *   input-required  — waiting on the participants in `awaiting`
 *   completed       — the room's question is settled (a new post reopens it)
 *   dormant         — resting, not dead: a new post revives it with history intact
 * Rooms from older snapshots have no `turn`; it is added on first use.
 */
const TURN_STATES = ['open', 'input-required', 'completed', 'dormant'];

function rawTurn(room) {
  if (!room.turn) {
    room.turn = { state: 'open', awaiting: [], note: null, updated_at: room.created_at, updated_by: null };
  }
  if (!room.seen) room.seen = {};
  return room.turn;
}

/** The room's turn, with awaited participants who are no longer around pruned first. */
function turnOf(room) {
  const turn = rawTurn(room);
  pruneAwaiting(room);
  return turn;
}

/**
 * Letters from other scripts that render like Latin ones, folded so that `jаson` (Cyrillic а)
 * or `nоva` (Cyrillic о) compares as `jason` / `nova`. Deliberately small: the common
 * Cyrillic and Greek lookalikes plus dotless i/j, not the full Unicode confusables table.
 */
const LOOKALIKES = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w', һ: 'h', ё: 'e', ї: 'i',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  ı: 'i', ȷ: 'j',
};
/** Capitals are folded before lowercasing, because Greek `Ν` looks like `N` but lowercases to `ν`. */
const LOOKALIKE_CAPITALS = {
  А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', Х: 'x', У: 'y',
  І: 'i', Ј: 'j', Ѕ: 's', Ӏ: 'l', Ԛ: 'q', Ԝ: 'w',
  Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't',
  Υ: 'y', Χ: 'x',
};

/**
 * The comparison form of a participant name: compatibility-normalized (fullwidth `ｊａｓｏｎ`
 * is `jason`), invisible characters (zero-width, bidi controls, Hangul fillers, variation
 * selectors, the blank braille cell, control characters) removed, whitespace collapsed,
 * lowercased, Latin accents and dots removed (`İLK` is `ilk`), and common lookalike letters
 * folded. Only for comparing; the display name is never changed. A name that is empty once
 * blanks are removed is refused.
 */
const BLANK_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u{16FE4}\u{1D159}]/gu;

function nameKey(id) {
  return String(id)
    .normalize('NFKC')
    .replace(BLANK_RE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/./gu, (c) => LOOKALIKE_CAPITALS[c] || c)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/./gu, (c) => LOOKALIKES[c] || c)
    .normalize('NFC');
}

function sameId(a, b) {
  return nameKey(a) === nameKey(b);
}

/** Longest comparison form (`nameKey`) a new name may have, in code points. AI ids are at most 64. */
const MAX_NAME_KEY = 64;
/** Longest name a mention can spell, in code points (handles are 40 units, AI ids 64). */
const MENTION_SPAN = 64;
/** Only the first this-many @s in a message are read as mentions (bounds the work per post). */
const MAX_MENTIONS_SCANNED = 64;
/** Per @, at most this many places where the name could end are tried (R12: bounds the folding work). */
const MAX_ENDINGS_PER_MENTION = 16;
/** Per message, at most this many candidate names are folded in total (R12-1, R12-2). */
const MAX_CANDIDATES = 256;
const NAME_CHAR = /[\p{L}\p{N}\p{M}_-]/u;
const NAME_START = /[\p{L}\p{N}\p{M}_]/u;
const NO_MENTIONS = new Float64Array(0);
/** One index per message object, made the first time it is needed (at post time) and kept with it. */
const mentionIndexes = new WeakMap();
let lastBody = null;
let lastIndex = NO_MENTIONS;
let lastWho = null;
let lastWhoHash = null;

/** A 53-bit hash of a folded name (two 32-bit multiply-xor hashes), so the index stores numbers, not text. */
function keyHash(k) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b ^= b >>> 15;
  }
  return a * 0x200000 + (b & 0x1fffff);
}

/**
 * Every folded name that `body` @mentions, as a sorted list of hashes, so checking a message
 * against many names is a lookup (8e-1: this used to fold every candidate for every name, which
 * let one post of @s stall the server).
 *
 * The rules: text in `code spans` is skipped. An @ counts only at the start of a word (not after
 * a letter, digit, `_` or `/`, so `bob@ana` and `x.org/@ana` don't mention), and only when a
 * name starts right after it (`@ ana` doesn't). A candidate name stops at the next @ or line
 * break, and ends only where a name can end: the next character is not a letter, digit or
 * mark in any script, `_` or `-`, nor a `.` followed by one. So `@ada` does not mention
 * `ada-bot`, `ada.bot` or `adaïs`, but `thanks @ada.` does. Only the first 64 @s are read.
 *
 * Bounds (R8e-1, R12): a candidate stops growing once its folded form is longer than any name can
 * be (MAX_NAME_KEY). Each @ tries at most 16 places where the name could end, and a message
 * folds at most 256 candidates in all, so building one index costs a few milliseconds at worst
 * and holds at most 256 numbers, however the text is crafted.
 */
function buildMentionIndex(body) {
  if (typeof body !== 'string' || !body.includes('@')) return NO_MENTIONS;
  const hashes = [];
  const text = Array.from(body.replace(/`[^`\n]*`/g, ' '));
  let budget = MAX_CANDIDATES;
  let endings = 0;
  const add = (i, j) => {
    budget--;
    endings++;
    const k = nameKey(text.slice(i + 1, j).join(''));
    if (Array.from(k).length > MAX_NAME_KEY) return false;
    if (k) hashes.push(keyHash(k));
    return true;
  };
  let scanned = 0;
  for (let i = 0; i < text.length && scanned < MAX_MENTIONS_SCANNED && budget > 0; i++) {
    if (text[i] !== '@') continue;
    if (i > 0 && (NAME_CHAR.test(text[i - 1]) || text[i - 1] === '/' || text[i - 1] === '@')) continue;
    if (!NAME_START.test(text[i + 1] || '')) continue;
    scanned++;
    endings = 0;
    const stop = Math.min(text.length, i + 1 + MENTION_SPAN);
    for (let j = i + 2; j <= stop; j++) {
      if (j < text.length) {
        const c = text[j];
        if (c === '@' || c === '\n') {
          add(i, j);
          break;
        }
        if (NAME_CHAR.test(c) || (c === '.' && NAME_CHAR.test(text[j + 1] || ''))) continue;
      }
      // Folding never makes a longer candidate shorter, so once one is too long, stop.
      if (!add(i, j) || endings >= MAX_ENDINGS_PER_MENTION || budget <= 0) break;
    }
  }
  if (!hashes.length) return NO_MENTIONS;
  const sorted = Float64Array.from(new Set(hashes)).sort();
  return sorted;
}

/**
 * Build the mention index of every message in the store, all at once (R12-1). Boot uses
 * indexMentionsInBackground instead, so the server can answer while it works.
 */
function indexAllMentions() {
  let n = 0;
  for (const room of openRooms.values()) {
    for (const m of room.messages) {
      mentionIndex(m);
      n++;
    }
  }
  return n;
}

/** While restored messages are still being indexed, the job's promise; otherwise null. */
let indexing = null;
let indexGeneration = 0;
/** How long each slice of background indexing may hold the event loop, in milliseconds. */
const INDEX_SLICE_MS = 8;

/**
 * Index every message that has no mention index yet, a few milliseconds at a time with a break
 * for other requests in between (R12-1b). Indexes live only in memory, so after a restore this
 * runs while the server is already answering. An inbox waits for it (see mentionsReady), because
 * building the rest in one go would stall every request. New posts are indexed when they arrive.
 * Resolves with the number of messages indexed.
 */
function indexMentionsInBackground({ sliceMs = INDEX_SLICE_MS } = {}) {
  const generation = ++indexGeneration;
  const pending = [];
  for (const room of openRooms.values()) {
    for (const m of room.messages) if (!mentionIndexes.has(m)) pending.push(m);
  }
  if (!pending.length) {
    indexing = null;
    return Promise.resolve(0);
  }
  let i = 0;
  const job = new Promise((resolve) => {
    const step = () => {
      if (generation !== indexGeneration) return resolve(i);
      const end = Date.now() + sliceMs;
      do mentionIndex(pending[i++]);
      while (i < pending.length && Date.now() < end);
      if (i < pending.length) setImmediate(step);
      else resolve(i);
    };
    setImmediate(step);
  });
  indexing = job;
  job.then(() => {
    if (indexing === job) indexing = null;
  });
  return job;
}

/** Whether restored messages are still being indexed. */
function mentionsIndexing() {
  return indexing !== null;
}

/**
 * Resolves true once every message has a mention index, or false if that takes longer than
 * `timeoutMs` (the caller then answers "try again shortly" rather than holding the request).
 */
function mentionsReady(timeoutMs = Infinity) {
  if (!indexing) return Promise.resolve(true);
  const job = indexing.then(() => true);
  if (!Number.isFinite(timeoutMs)) return job;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
}

/** The mention index for a message object (kept with the message) or a body string. */
function mentionIndex(messageOrBody) {
  if (messageOrBody && typeof messageOrBody === 'object') {
    let idx = mentionIndexes.get(messageOrBody);
    if (!idx) {
      idx = buildMentionIndex(messageOrBody.body);
      mentionIndexes.set(messageOrBody, idx);
    }
    return idx;
  }
  // A bare string keeps only the last one, which covers checking one body against many names.
  if (messageOrBody !== lastBody) {
    lastIndex = buildMentionIndex(messageOrBody);
    lastBody = messageOrBody;
  }
  return lastIndex;
}

/**
 * Whether a message (or a body string) @mentions `who`, comparing names the way joins do
 * (see buildMentionIndex).
 */
function mentionsName(messageOrBody, who) {
  // The same name is usually checked against many messages in a row (inbox), so fold it once.
  if (who !== lastWho) {
    const target = nameKey(who);
    lastWhoHash = !target || Array.from(target).length > MAX_NAME_KEY ? null : keyHash(target);
    lastWho = who;
  }
  const h = lastWhoHash;
  if (h === null) return false;
  const idx = mentionIndex(messageOrBody);
  let lo = 0;
  let hi = idx.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx[mid] === h) return true;
    if (idx[mid] < h) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function cleanAwaiting(list, except) {
  const out = [];
  for (const raw of list || []) {
    const id = String(raw).trim().replace(/^@/, '');
    if (!id || (except && sameId(id, except))) continue;
    if (!out.some((x) => sameId(x, id))) out.push(id);
  }
  return out;
}

/**
 * Set the turn state directly (without posting). `awaiting` non-empty forces
 * input-required; input-required with nobody awaited falls back to open.
 */
function setTurn(room, { state, awaiting, note, by }, fresh) {
  const turn = turnOf(room);
  if (state !== undefined && !TURN_STATES.includes(state)) {
    const err = new Error('invalid_state');
    err.code = 'invalid_state';
    throw err;
  }
  if (awaiting !== undefined) turn.awaiting = cleanAwaiting(awaiting);
  if (state !== undefined) turn.state = state;
  if (awaiting !== undefined && turn.awaiting.length && state === undefined) turn.state = 'input-required';
  if (turn.state !== 'input-required') turn.awaiting = [];
  if (turn.state === 'input-required' && turn.awaiting.length === 0) turn.state = 'open';
  if (note !== undefined) turn.note = note || null;
  // Handing the turn (directly, or the `fresh` ids of a post) restarts that id's grace clock.
  stampAwaiting(room, fresh === undefined ? awaiting : fresh);
  turn.updated_at = nowIso();
  turn.updated_by = by || null;
  return turn;
}

/**
 * When each awaited id was handed the turn (nameKey of the id → ms), kept on the room so the
 * turn object's shape is unchanged. Ids from older snapshots fall back to turn.updated_at.
 */
function awaitingSince(room) {
  const turn = rawTurn(room);
  if (!room.awaiting_since || typeof room.awaiting_since !== 'object') room.awaiting_since = {};
  const since = room.awaiting_since;
  const legacy = Date.parse(turn.updated_at) || now();
  const keep = {};
  for (const id of turn.awaiting) {
    const k = nameKey(id);
    keep[k] = typeof since[k] === 'number' ? since[k] : legacy;
  }
  room.awaiting_since = keep;
  return keep;
}

function stampAwaiting(room, ids) {
  const since = awaitingSince(room);
  const t = now();
  for (const id of cleanAwaiting(ids)) {
    const k = nameKey(id);
    if (k in since) since[k] = t;
  }
}

/**
 * Is anyone with this id on the roster (of either party, or only `party` if given)? Turn logic
 * (awaiting, pruning, implicit handoff) always compares ids this one way (see nameKey).
 */
function inRoster(room, id, party) {
  for (const p of room.roster.values()) if ((!party || p.party === party) && sameId(p.id, id)) return true;
  return false;
}

/**
 * Whether a name in `awaiting` means this participant. Awaited ids carry no party, and a
 * name can be held by a human who timed out while an AI of that name is present (only one of
 * them can be present). The name then means whoever is present, so the absent one is not told
 * it is their turn.
 */
function awaits(room, awaiting, party, id) {
  if (!(awaiting || []).some((a) => sameId(a, id))) return false;
  const other = party === 'ai' ? 'human' : 'ai';
  return inRoster(room, id, party) || !inRoster(room, id, other);
}

/** input-required with nobody left to wait for falls back to open (same rule as setTurn). */
function settleTurn(turn, by) {
  if (turn.state === 'input-required' && turn.awaiting.length === 0) turn.state = 'open';
  turn.updated_at = nowIso();
  turn.updated_by = by || null;
}

/**
 * Self-heal: drop awaited ids that are not on the roster, unless they were handed the turn,
 * or timed out, within the last presence TTL (so an AI that is being woken, or an invitee,
 * has time to arrive). An absent awaited id therefore lingers at most one TTL. Stale lists
 * such as awaiting participants who left long ago clear on first read.
 */
function pruneAwaiting(room) {
  const turn = rawTurn(room);
  if (!turn.awaiting.length) {
    room.awaiting_since = {};
    return false;
  }
  const since = awaitingSince(room);
  const grace = presenceTtlMs() || DEFAULT_PRESENCE_TTL_MS;
  const t = now();
  const kept = turn.awaiting.filter((id) => inRoster(room, id) || t - since[nameKey(id)] <= grace);
  if (kept.length === turn.awaiting.length) return false;
  turn.awaiting = kept;
  awaitingSince(room);
  settleTurn(turn, null);
  dirty = true;
  return true;
}

/** A participant left: stop awaiting them now (unless someone with the same id remains). */
function dropAwaiting(room, id) {
  const turn = rawTurn(room);
  if (inRoster(room, id) || !turn.awaiting.some((a) => sameId(a, id))) return;
  turn.awaiting = turn.awaiting.filter((a) => !sameId(a, id));
  awaitingSince(room);
  settleTurn(turn, id);
}

/**
 * Append a message. `party` is decided by the caller's authenticated path,
 * never by the message content. Optional `turn_id` / `status` carry the
 * inquiry turn format (e.g. "SBO-012-Claude", "awaiting Grok").
 *
 * Turn effects: the author stops being awaited; a post into a completed or
 * dormant room reopens it; `awaiting` hands the turn to the named participants;
 * a human post that names nobody, right after an AI's message, hands the turn to that AI;
 * `reply_to` (a message id in this room) links the post to the message it answers;
 * `state` (completed | dormant | open) sets the room state after this post.
 */
function addMessage(room, { author, party, body, turn_id, status, awaiting, state, reply_to }) {
  const turn = turnOf(room);
  const message = {
    id: `msg_${crypto.randomBytes(6).toString('hex')}`,
    room_id: room.id,
    author,
    party,
    body,
    created_at: nowIso(),
  };
  if (turn_id) message.turn_id = turn_id;
  if (status) message.status = status;
  if (reply_to) {
    const target = room.messages.find((m) => m.id === reply_to);
    if (target) {
      message.reply_to = target.id;
      message.reply_to_author = target.author;
    }
  }
  let handTo = cleanAwaiting(awaiting, author);
  // A person answering straight after an AI, without naming anyone, is replying to that AI:
  // hand it the turn. Humans only, so two AIs can never wake each other in a loop.
  const prev = room.messages[room.messages.length - 1];
  if (
    !handTo.length &&
    !state &&
    party === 'human' &&
    prev &&
    prev.party === 'ai' &&
    inRoster(room, prev.author, 'ai') &&
    !/(^|\s)@[^\s@]/.test(body)
  ) {
    handTo = [prev.author];
    message.implicit_turn = true;
  }
  if (handTo.length) message.awaiting = handTo;
  room.messages.push(message);
  mentionIndex(message);

  let nextAwaiting = turn.awaiting.filter((id) => !sameId(id, author));
  let nextState = turn.state === 'completed' || turn.state === 'dormant' ? 'open' : turn.state;
  if (handTo.length) {
    nextAwaiting = cleanAwaiting([...nextAwaiting, ...handTo]);
    nextState = 'input-required';
  }
  if (state) nextState = state;
  setTurn(room, { state: nextState, awaiting: nextAwaiting, note: null, by: author }, handTo);
  touch(room, party, author);
  room.seen[rosterKey(party, author)] = message.id;
  lastRooms.set(rosterKey(party, author), room.id);
  for (const fn of messageListeners) {
    try {
      fn(room, message);
    } catch (err) {
      console.error('Message listener failed:', err);
    }
  }
  return message;
}

/** Record that a participant has read the room up to its latest message. */
function markSeen(room, party, id) {
  turnOf(room);
  touch(room, party, id);
  const last = room.messages[room.messages.length - 1];
  if (last) room.seen[rosterKey(party, id)] = last.id;
}

/**
 * What is waiting for a participant across all rooms: rooms whose turn awaits
 * them, and rooms they belong to (or are mentioned in) with unread messages.
 */
function inboxItem(room, party, id) {
  const key = rosterKey(party, id);
  const turn = turnOf(room);
  const seenId = room.seen[key];
  const idx = seenId ? room.messages.findIndex((m) => m.id === seenId) : -1;
  const unread = room.messages.slice(idx + 1).filter((m) => !(m.party === party && sameId(m.author, id)));
  const awaited = turn.state === 'input-required' && awaits(room, turn.awaiting, party, id);
  const mentions = unread.filter((m) => mentionsName(m, id)).length;
  const member = isMember(room, party, id);
  if (!awaited && !mentions && !(member && unread.length)) return null;
  const last = room.messages[room.messages.length - 1];
  return {
    room_id: room.id,
    title: room.title,
    state: turn.state,
    awaiting: turn.awaiting.slice(),
    your_turn: awaited,
    unread: unread.length,
    mentions,
    first_unread: unread.length ? unread[0].id : null,
    last_activity: last ? last.created_at : room.created_at,
  };
}

function sortInbox(items) {
  items.sort((a, b) => Number(b.your_turn) - Number(a.your_turn) || b.last_activity.localeCompare(a.last_activity));
  return items;
}

function inbox(party, id, { roomId } = {}) {
  const items = [];
  const rooms = roomId === undefined ? openRooms.values() : [openRooms.get(roomId)].filter(Boolean);
  for (const room of rooms) {
    sweep(room);
    const item = inboxItem(room, party, id);
    if (item) items.push(item);
  }
  return sortInbox(items);
}

/**
 * A guest's inbox: every room where this guest holds a human name, each item carrying the
 * name (`handle`) it is for. Rooms where someone else of the same name is mentioned or awaited
 * are not this guest's business and are left out.
 */
function guestInbox(gid) {
  const items = [];
  if (!gid) return items;
  for (const room of openRooms.values()) {
    sweep(room);
    for (const [key, rec] of Object.entries(membersOf(room))) {
      if (!key.startsWith('human:') || !rec || rec.owner !== gid) continue;
      const handle = key.slice('human:'.length);
      const item = inboxItem(room, 'human', handle);
      if (item) items.push({ ...item, handle });
    }
  }
  return sortInbox(items);
}

/** Look up a room; expires idle parties and prunes the turn before anyone sees it. */
function getRoom(id) {
  const room = openRooms.get(id) || null;
  if (room) sweep(room);
  return room;
}

function listRoster(room) {
  return Array.from(room.roster.values()).map((p) => ({
    id: p.id,
    party: p.party,
    joined_at: p.joined_at,
    last_seen: p.last_seen || p.joined_at,
  }));
}

/** Record activity by a participant (no-op if they are not on the roster). */
function touch(room, party, id) {
  const key = rosterKey(party, id);
  const entry = room.roster.get(key);
  const at = nowIso();
  if (entry) entry.last_seen = at;
  const rec = party === 'human' ? membersOf(room)[key] : null;
  if (rec && typeof rec === 'object') rec.last_active = at;
  return Boolean(entry);
}

/**
 * When `entry` was last seen, for expiry. Restored entries get one fresh TTL from this boot,
 * except unclaimed names from before guest keys: nothing can refresh those (every call needs a
 * key that holds the name), so one restored from before this boot counts as away at once and
 * its owner's own page or app claims it on reload. Giving them the boot TTL would open them all
 * at one predictable moment ten minutes after a deploy (QC Handoff 14, 2b and 3).
 */
function lastSeenMs(entry, room) {
  const seen = Date.parse(entry.last_seen || entry.joined_at) || 0;
  if (room && entry.party === 'human') {
    const rec = membersOf(room)[rosterKey('human', entry.id)];
    if (rec && typeof rec === 'object' && !rec.owner) return seen < presenceEpoch ? 0 : seen;
  }
  return Math.max(seen, presenceEpoch);
}

/**
 * Expire parties idle longer than the presence TTL, through the same path as leave
 * (AI credentials are revoked). Unlike an explicit leave, expiry never deletes the room:
 * an idle room keeps its history. Returns the expired { id, party } entries.
 */
function expireIdle(room) {
  membersOf(room);
  const ttl = presenceTtlMs();
  const t = now();
  const expired = [];
  for (const entry of Array.from(room.roster.values())) {
    const seen = lastSeenMs(entry, room);
    // Restored entries (no last_seen, or one from before this boot) show the boot time.
    if (!entry.last_seen || Date.parse(entry.last_seen) < seen) entry.last_seen = new Date(seen).toISOString();
    if (ttl && t - seen > ttl) {
      removeParty(room, entry.party, entry.id, { dropTurn: false });
      restartGrace(room, entry.id, seen + ttl);
      expired.push({ id: entry.id, party: entry.party });
    }
  }
  if (expired.length) dirty = true;
  return expired;
}

/** An awaited party that just timed out keeps the turn for one TTL from its expiry. */
function restartGrace(room, id, at) {
  if (!rawTurn(room).awaiting.some((a) => sameId(a, id))) return;
  const since = awaitingSince(room);
  const k = nameKey(id);
  since[k] = Math.max(since[k], at);
}

/**
 * Release human memberships with no activity for guestReleaseMs() (30 days): the name is free
 * again, what they last read is forgotten, and notify drops that name's subscriptions. Only
 * names nobody is present under; like expiry, this never deletes a room.
 */
function releaseIdle(room) {
  const members = membersOf(room);
  const t = now();
  const released = [];
  for (const [key, rec] of Object.entries(members)) {
    if (!key.startsWith('human:') || !rec || typeof rec !== 'object' || room.roster.has(key)) continue;
    if (t - (Date.parse(rec.last_active) || 0) <= guestReleaseMs()) continue;
    delete members[key];
    if (room.seen) delete room.seen[key];
    released.push({ room_id: room.id, owner: rec.owner || null, handle: key.slice('human:'.length) });
  }
  if (released.length) {
    dirty = true;
    for (const r of released) emitGuestEvent({ type: 'release', ...r });
  }
  return released;
}

/** Lazy housekeeping on every read or change: expire idle parties, release idle names, prune the turn. */
function sweep(room) {
  const expired = expireIdle(room);
  releaseIdle(room);
  pruneAwaiting(room);
  return expired;
}

function identityError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/**
 * One name per participant, so turn logic (which compares names with `sameId`) never confuses
 * two participants. Names are compared by `nameKey`: case, width, accents, invisible
 * characters and common lookalike letters don't make a new name.
 *
 * - In your own party, a name is held by anyone present or kept as a member (timed out but
 *   not left): a variant of it gets `handle_taken`.
 * - Across parties, a name is held while its owner is present. A guest's name also holds
 *   against AIs while the guest keeps it (until they leave or it is released after 30 idle
 *   days), so "nobody else can use that name" holds while it's theirs. An AI or an unclaimed
 *   pre-guest membership that walked away does not block the other party. The exact name held
 *   by the other party is `invalid_party`; a variant is `handle_taken`.
 * - Rejoining as yourself (same party, same spelling) passes if you are present. A kept member
 *   rejoining passes unless the other party is using the name right now. Duplicates restored
 *   from older snapshots keep rejoining under their own spelling.
 *
 * Error text never repeats the held name, so a refusal does not reveal who else holds it.
 */
function assertIdFree(room, party, id) {
  const key = rosterKey(party, id);
  if (room.roster.has(key)) return;
  const members = membersOf(room);
  const kept = Boolean(members[key]);
  const wanted = nameKey(id);
  const ownParty = `${party}:`;
  const guestHeld = (k) => k.startsWith('human:') && members[k] && members[k].owner;
  const held = new Set([
    ...room.roster.keys(),
    ...Object.keys(members).filter((k) => k.startsWith(ownParty) || (party === 'ai' && guestHeld(k))),
  ]);
  for (const k of held) {
    if (k === key) continue;
    const i = k.indexOf(':');
    const otherParty = k.slice(0, i);
    const otherId = k.slice(i + 1);
    if (nameKey(otherId) !== wanted) continue;
    if (otherParty === party) {
      if (kept) continue;
      throw identityError('handle_taken', 'That name, or one that looks the same, is already taken in this room.');
    }
    if (otherId === id) {
      if (!room.roster.has(k)) throw identityError('invalid_party', 'That name is held in this room by a human.');
      throw identityError('invalid_party', `That name is in use in this room right now by ${otherParty === 'ai' ? 'an AI' : 'a human'}.`);
    }
    throw identityError('handle_taken', 'That name, or one that looks the same, is in use in this room right now.');
  }
}

/**
 * Zero-width spaces, bidi controls, control characters and other invisible marks make a handle
 * look like another one (or display reversed). Joiners (U+200C, U+200D) stay allowed: scripts
 * and emoji need them. AI ids are ASCII-only already.
 */
const INVISIBLE_RE = /[\p{Cc}\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/** A new human name: nothing invisible, not blank, and a comparison form of at most MAX_NAME_KEY. */
function nameAllowed(handle) {
  if (INVISIBLE_RE.test(handle)) return false;
  const k = nameKey(handle);
  return Boolean(k) && Array.from(k).length <= MAX_NAME_KEY;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function assertCapacity(room) {
  if (room.roster.size >= MAX_PARTIES) {
    const err = new Error('room_full');
    err.code = 'room_full';
    throw err;
  }
}

/**
 * Join (or re-join) a human as guest `gid` (null when the request had no valid guest key).
 * Returns { room, created, guest_key }; guest_key is set only when this join minted one.
 *
 * A held name answers only to the guest that owns it: anyone else, with or without a key, gets
 * the same generic handle_taken a lookalike gets. A membership from before guest keys (no
 * owner) is claimed by the first rejoin, but never while the name is present: whoever is on the
 * roster may be its real holder. A claim drops the name's old notification subscriptions in
 * that room rather than handing them to the claimer. A keyless rejoin mints a key and claims in
 * one step. One key holds at most MAX_NAMES_PER_GUEST distinct names across all rooms. A key is
 * minted only after every check has passed, so a refused join hands out nothing.
 */
function joinHuman(room, handle, gid = null) {
  const key = rosterKey('human', handle);
  // New names only: a handle joined before these rules (e.g. restored from a snapshot) can still re-join.
  if (!isMember(room, 'human', handle) && !nameAllowed(handle)) {
    throw protocolError('invalid_handle');
  }
  const members = membersOf(room);
  const rec = members[key] && typeof members[key] === 'object' ? members[key] : null;
  if (rec && rec.owner && rec.owner !== gid) {
    throw identityError('handle_taken', 'That name, or one that looks the same, is already taken in this room.');
  }
  assertIdFree(room, 'human', handle);
  const present = room.roster.has(key);
  const claim = Boolean(rec) && !rec.owner;
  if (claim && present) {
    // Same words as a held name, so a refusal doesn't say which names are claimable or when.
    throw identityError('handle_taken', 'That name, or one that looks the same, is already taken in this room.');
  }
  if (!present) assertCapacity(room);
  if (gid && !(rec && rec.owner === gid) && !guestHolds(gid, handle) && namesHeldBy(gid).size >= MAX_NAMES_PER_GUEST) {
    throw protocolError('guest_name_limit');
  }
  let guestKey = null;
  if (!gid) ({ key: guestKey, gid } = mintGuest());
  const at = nowIso();
  // Old subscriptions for an unclaimed name are dropped, not handed to the claimer.
  if (claim) emitGuestEvent({ type: 'release', room_id: room.id, owner: null, handle });
  members[key] = { owner: gid, last_active: at };
  if (present) {
    touch(room, 'human', handle);
  } else {
    room.roster.set(key, { id: handle, party: 'human', joined_at: at, last_seen: at });
  }
  return { room, created: !present, guest_key: guestKey };
}

/**
 * Join (or re-join) an AI agent. Returns { room, credential, created }.
 *
 * The join route is unauthenticated, so an agent that is already present never has its live
 * credential handed out: a re-join must present that credential (`auth.credential`, the
 * request's Bearer), and gets the same membership and the same token back; anyone else gets
 * `handle_taken`. `auth.trusted` is for callers that have already authenticated the agent
 * by other means (the MCP endpoint's connector key). An agent that is absent (never joined,
 * left, or timed out) joins fresh and gets a new credential.
 */
function joinAi(room, agentId, auth = {}) {
  const key = rosterKey('ai', agentId);
  assertIdFree(room, 'ai', agentId);
  if (room.roster.has(key)) {
    const existing = room.roster.get(key);
    const live = Boolean(existing.credential) && credentials.has(existing.credential);
    const proven = live && sameSecret(auth.credential, existing.credential);
    if (!proven && !auth.trusted) {
      throw identityError(
        'handle_taken',
        `${agentId} is already present in this room. Re-join with its Bearer credential, or join after it leaves or times out.`
      );
    }
    if (!live) {
      const token = mintCredential();
      existing.credential = token;
      credentials.set(token, { room_id: room.id, agent_id: agentId });
    }
    touch(room, 'ai', agentId);
    membersOf(room)[key] = true;
    return { room, credential: existing.credential, created: false };
  }
  assertCapacity(room);
  const token = mintCredential();
  const at = nowIso();
  room.roster.set(key, {
    id: agentId,
    party: 'ai',
    joined_at: at,
    last_seen: at,
    credential: token,
  });
  credentials.set(token, { room_id: room.id, agent_id: agentId });
  membersOf(room)[key] = true;
  return { room, credential: token, created: true };
}

function resolveCredential(token) {
  if (!token || typeof token !== 'string') return null;
  return credentials.get(token) || null;
}

/**
 * Resolve an AI Bearer for an authenticated call: sweeps the credential's room first (an
 * agent idle past the TTL is expired and its credential revoked, so this returns null),
 * then records the call as activity.
 */
function authenticate(token) {
  const binding = resolveCredential(token);
  if (!binding) return null;
  const room = getRoom(binding.room_id);
  const live = resolveCredential(token);
  if (live && room) touch(room, 'ai', live.agent_id);
  return live;
}

function hasHuman(room, handle) {
  return room.roster.has(rosterKey('human', handle));
}

function hasAi(room, agentId) {
  return room.roster.has(rosterKey('ai', agentId));
}

/**
 * The one removal path, shared by leave and presence expiry: revoke an AI's credential,
 * drop the roster entry and (on leave) stop awaiting them. Returns true if they were present.
 */
function removeParty(room, party, id, { dropTurn = true } = {}) {
  const key = rosterKey(party, id);
  const entry = room.roster.get(key);
  if (!entry) return false;
  if (entry.credential) credentials.delete(entry.credential);
  room.roster.delete(key);
  // On expiry the awaited id instead follows pruneAwaiting's grace rule.
  if (dropTurn) dropAwaiting(room, entry.id);
  return true;
}

/**
 * Explicit leave: off the roster and no longer a member (ends `message` notifications and
 * inbox unread), and no longer awaited. Someone who is neither present nor a member gets
 * false and changes nothing. Only a real leave can delete a room, and only when it leaves
 * nobody present and no kept members (see maybeGc). Expiry never deletes a room.
 */
function leaveParty(room, party, id) {
  const members = membersOf(room);
  const key = rosterKey(party, id);
  if (!room.roster.has(key) && !members[key]) return false;
  const rec = members[key];
  delete members[key];
  if (!removeParty(room, party, id)) dropAwaiting(room, id); // an expired member leaving
  for (const fn of leaveListeners) {
    try {
      fn(room, party, id);
    } catch (err) {
      console.error('Leave listener failed:', err);
    }
  }
  maybeGc(room);
  if (party === 'human') emitGuestEvent({ type: 'release', room_id: room.id, owner: (rec && rec.owner) || null, handle: id });
  return true;
}

function leaveHuman(room, handle) {
  return leaveParty(room, 'human', handle);
}

function leaveAi(room, agentId) {
  return leaveParty(room, 'ai', agentId);
}

/** Delete a room with nobody present and no kept members. The lobby is never deleted. */
function maybeGc(room) {
  if (room.id === OPEN_WELCOME_ROOM_ID) return false;
  if (room.roster.size > 0 || Object.keys(membersOf(room)).length > 0) return false;
  openRooms.delete(room.id);
  return true;
}

function clearAll() {
  indexGeneration++;
  indexing = null;
  openRooms.clear();
  credentials.clear();
  guests.clear();
  presenceEpoch = now();
  ensureWelcomeLobby();
}

ensureWelcomeLobby();
console.log(describePresenceTtl());

module.exports = {
  MAX_NAMES_PER_GUEST,
  nameKey,
  sameId,
  mentionsName,
  MAX_MENTIONS_SCANNED,
  MAX_ENDINGS_PER_MENTION,
  MAX_CANDIDATES,
  MAX_NAME_KEY,
  indexAllMentions,
  indexMentionsInBackground,
  mentionsIndexing,
  mentionsReady,
  awaits,
  MAX_PARTIES,
  OPEN_WELCOME_ROOM_ID,
  OPEN_WELCOME_TITLE,
  DEFAULT_PRESENCE_TTL_MS,
  MIN_PRESENCE_TTL_MS,
  presenceTtlMs,
  describePresenceTtl,
  takeDirty,
  isMember,
  DEFAULT_GUEST_RELEASE_MS,
  guestReleaseMs,
  resolveGuest,
  ownsHuman,
  holdsIn,
  guestHolds,
  guestInbox,
  onGuestEvent,
  createRoom,
  listRooms,
  updateRoom,
  VISIBILITIES,
  addMessage,
  lastRoomOf,
  onMessage,
  onLeave,
  setTurn,
  turnOf,
  markSeen,
  inbox,
  TURN_STATES,
  getRoom,
  listRoster,
  joinHuman,
  joinAi,
  resolveCredential,
  authenticate,
  touch,
  sweep,
  hasHuman,
  hasAi,
  leaveHuman,
  leaveAi,
  ensureWelcomeLobby,
  clearAll,
  _setClock,
  /** Tests: pretend the server booted at `ms` (default now). */
  _setPresenceEpoch(ms) {
    const was = presenceEpoch;
    presenceEpoch = ms === undefined ? now() : ms;
    return was;
  },
  _openRooms: openRooms,
  _credentials: credentials,
  _guests: guests,
};
