/**
 * Guest identity logic shared by the Open and Human streams (factored out of #41).
 *
 * This module holds LOGIC ONLY. Each stream creates its own registry with createGuestRegistry(),
 * so an Open guest key means nothing in a Human room and the other way round: the streams share
 * how guest keys work, never the keys, names or rooms themselves.
 *
 * - A human join without a key gets a fresh random key, returned once in the join response and
 *   never again. The client sends it as X-Lyceum-Guest; only its sha256 is kept, mapped to a
 *   guest record. `type` leaves room for other kinds of record later, and `account_id` is where
 *   a member account will attach. `gid` is internal and not secret.
 * - One key holds at most MAX_NAMES_PER_GUEST distinct names across a stream's rooms.
 * - A name unused for guestReleaseMs() (30 days by default) is released.
 * - Names are compared by nameKey(): case, width, accents, invisible characters and common
 *   lookalike letters don't make a new name. Refusals use one generic message that never
 *   repeats the held name or says who holds it.
 */
const crypto = require('crypto');
const { protocolError } = require('./errors');

/** Distinct human names one guest key may hold across all rooms of a stream (the /guests page states it). */
const MAX_NAMES_PER_GUEST = 5;
/** The request header a returning guest presents its key in (Express lowercases header names). */
const GUEST_HEADER = 'x-lyceum-guest';
const GUEST_KEY_RE = /^g_[A-Za-z0-9_-]{43}$/;
const DEFAULT_GUEST_RELEASE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_GUEST_RELEASE_MS = 60 * 1000;
const releaseCache = { raw: undefined, value: DEFAULT_GUEST_RELEASE_MS };

/**
 * How long a human name may go unused before it is released: OPEN_GUEST_RELEASE_MS, default
 * 30 days (the /guests promise). Shorter values are for testing; whole numbers of at least
 * 60000 only, anything else falls back to the default with a warning. (The variable keeps its
 * #41 name; it now sets the window for both streams.)
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

/** True when a name last active at `lastActiveIso` is due for release at time `t` (ms). */
function releaseDue(lastActiveIso, t) {
  return t - (Date.parse(lastActiveIso) || 0) > guestReleaseMs();
}

function hashGuestKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * One stream's guest registry: sha256(key) → { gid, type, created_at, account_id }.
 * `newId(prefix)` and `nowIso()` come from the owning store so ids and clocks stay its own.
 */
function createGuestRegistry({ newId, nowIso }) {
  const guests = new Map();

  function mint() {
    const key = `g_${crypto.randomBytes(32).toString('base64url')}`;
    const record = { gid: newId('gst'), type: 'guest', created_at: nowIso(), account_id: null };
    guests.set(hashGuestKey(key), record);
    return { key, gid: record.gid };
  }

  /** The guest id for a key, or null for a missing, malformed or unknown key. */
  function resolve(key) {
    if (typeof key !== 'string' || !GUEST_KEY_RE.test(key)) return null;
    const record = guests.get(hashGuestKey(key));
    return record ? record.gid : null;
  }

  /**
   * Drop guest records that hold no names. `heldGids` is a Set of guest ids that still own at
   * least one name in the stream. Returns how many records were removed. Safe to call from a
   * room sweep or a snapshot write; Open and Human each pass their own held set.
   */
  function pruneEmpty(heldGids) {
    const held = heldGids instanceof Set ? heldGids : new Set(heldGids || []);
    let n = 0;
    for (const [hash, record] of guests) {
      if (record && record.gid && !held.has(record.gid)) {
        guests.delete(hash);
        n += 1;
      }
    }
    return n;
  }

  return { guests, mint, resolve, pruneEmpty, clear: () => guests.clear() };
}

/** The raw guest key a request carries, or undefined. */
function guestKeyOf(req) {
  return req.headers[GUEST_HEADER];
}

/** The guest id behind this request's X-Lyceum-Guest header (per `registry`), or null. */
function guestOf(req, registry) {
  return registry.resolve(guestKeyOf(req));
}

/** As guestOf, but a request without a valid key is 401 guest_key_required. */
function requireGuest(req, registry) {
  const gid = guestOf(req, registry);
  if (!gid) throw protocolError('guest_key_required');
  return gid;
}

/**
 * Acting as a human name: the name must be joined (`joined`), and the request must carry the
 * guest key that holds it (`owns(gid)`). A name that isn't joined is not_joined; no key is
 * guest_key_required; someone else's key is not_joined (so a wrong key learns nothing).
 */
function requireOwnName(req, registry, { joined, owns }) {
  if (!joined) throw protocolError('not_joined');
  const gid = requireGuest(req, registry);
  if (!owns(gid)) throw protocolError('not_joined');
  return gid;
}

/* ---------- Names ---------- */

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

/* ---------- Join rules ---------- */

/** The one refusal for a held, claimable-but-present or lookalike name. Never names the holder. */
const NAME_TAKEN_MESSAGE = 'That name, or one that looks the same, is already taken in this room.';

function identityError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function nameTakenError() {
  return identityError('handle_taken', NAME_TAKEN_MESSAGE);
}

/**
 * `rec` is the name's record in a room ({ owner, last_active }, owner null for a name from
 * before guest keys), or null. A name held by another guest answers to nobody else: with or
 * without a key, the caller gets the generic handle_taken.
 */
function assertNotHeldByOther(rec, gid) {
  if (rec && rec.owner && rec.owner !== gid) throw nameTakenError();
}

/**
 * A name from before guest keys (a record with no owner) is claimed by the first rejoin, but
 * never while the name is present: whoever is on the roster may be its real holder. Same words
 * as a held name, so a refusal doesn't say which names are claimable or when. Returns whether
 * this join is a claim.
 */
function assertClaimable(rec, present) {
  const claim = Boolean(rec) && !rec.owner;
  if (claim && present) throw nameTakenError();
  return claim;
}

/**
 * One key holds at most MAX_NAMES_PER_GUEST distinct names. A name the guest already holds
 * (here, `rec`, or anywhere in the stream, `holdsName()`) never counts against it.
 * `heldCount()` is the number of distinct names the guest holds across the stream.
 */
function assertUnderNameCap(gid, rec, { holdsName, heldCount }) {
  if (gid && !(rec && rec.owner === gid) && !holdsName() && heldCount() >= MAX_NAMES_PER_GUEST) {
    throw protocolError('guest_name_limit');
  }
}

module.exports = {
  MAX_NAMES_PER_GUEST,
  GUEST_HEADER,
  GUEST_KEY_RE,
  DEFAULT_GUEST_RELEASE_MS,
  MIN_GUEST_RELEASE_MS,
  guestReleaseMs,
  releaseDue,
  hashGuestKey,
  createGuestRegistry,
  guestKeyOf,
  guestOf,
  requireGuest,
  requireOwnName,
  nameKey,
  sameId,
  MAX_NAME_KEY,
  nameAllowed,
  NAME_TAKEN_MESSAGE,
  identityError,
  nameTakenError,
  assertNotHeldByOther,
  assertClaimable,
  assertUnderNameCap,
};
