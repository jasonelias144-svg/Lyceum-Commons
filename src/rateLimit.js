/**
 * Post rate limit (R12-1b, soft-first ladder). Messages persist and every restart reads them all
 * back, so one client posting without pause makes every later boot slower. Rungs, all tunable:
 *  - per key: each guest (Open human) or AI credential gets OPEN_POST_RATE_PER_MIN posts (default 30)
 *    in a bucket that refills evenly over a minute; MCP connectors get the same, keyed by connector;
 *  - new keys earn it: a key minted moments ago (the join that mints it calls markNew) starts at
 *    OPEN_POST_NEW_KEY_BURST (5) and its allowance grows evenly to the full rate over
 *    OPEN_POST_NEW_KEY_RAMP_MS (10 minutes);
 *  - per address: every key from one address shares OPEN_POST_IP_RATE_PER_MIN (120), so minting
 *    keys doesn't help; requests with no trustworthy address share one fallback bucket at the
 *    per-key rate;
 *  - Human stream (/api/human): with a guest key, the poster's key (live HUMAN_LIVE_POST_RATE_PER_MIN
 *    default 45, board HUMAN_BOARD_POST_RATE_PER_MIN default 20) under HUMAN_POST_IP_RATE_PER_MIN
 *    (120) per address and HUMAN_POST_ROOM_RATE_PER_MIN (90) per room; without a key, address alone
 *    at HUMAN_POST_RATE_PER_MIN (30). New Human keys ramp via HUMAN_POST_NEW_KEY_BURST (8) over
 *    HUMAN_POST_NEW_KEY_RAMP_MS (10 min). Writing joins share HUMAN_JOIN_RATE_PER_MIN (10) per
 *    address and JOIN_SITE_RATE_PER_MIN (300) site-wide; rejoins HUMAN_REJOIN_RATE_PER_MIN (30)
 *    per key. Guestbook HUMAN_GUESTBOOK_RATE_PER_MIN (3); branch/merge HUMAN_STRUCT_RATE_PER_MIN (6).
 *  - AI stream (/api/ai): separate knobs — per credential AI_POST_RATE_PER_MIN (120), per address
 *    AI_POST_IP_RATE_PER_MIN (120), per room AI_POST_ROOM_RATE_PER_MIN (240); new credentials start
 *    at AI_POST_NEW_KEY_BURST (10) and ramp over AI_POST_NEW_KEY_RAMP_MS (15 min), or earn full rate
 *    after AI_POST_EARN_OUT_POSTS (50) accepted posts; joins at AI_JOIN_IP_RATE_PER_MIN (12) per
 *    address and AI_JOIN_AGENT_RATE_PER_MIN (6) per agent_id from one address. Open joins (human and
 *    Open-composition AI) at OPEN_JOIN_IP_RATE_PER_MIN (12) per address; every writing join across
 *    Open, /api/ai and Human also shares JOIN_SITE_RATE_PER_MIN (300). Open-composition AI posts
 *    stay on Open's 30/min bucket.
 * A refusal is a 429 with Retry-After and a plain message; nothing is delayed or dropped silently.
 * OPEN_POST_RATE_PER_MIN=0 turns the Open and MCP limits off. AI_POST_RATE_PER_MIN=0 turns the AI
 * post limits off.
 */
const DEFAULT_PER_MIN = 30;
/** Buckets that have refilled completely are dropped once there are this many keys. */
const PRUNE_AT = 10000;

function perMinute() {
  return envNumber('OPEN_POST_RATE_PER_MIN', DEFAULT_PER_MIN);
}

/**
 * The header that carries the client's address, when a proxy we trust sets it (lowercase name), or
 * null to use req.ip. OPEN_CLIENT_IP_HEADER names it ('none' turns it off). On Railway it defaults
 * to x-real-ip: Railway's edge sets that header and overwrites any value a client sends, while
 * X-Forwarded-For carries an internal hop that changes per connection, so req.ip there is not the
 * client (live QC on 3acf30f: 42 posts from one address, no 429).
 */
function clientIpHeader() {
  const raw = process.env.OPEN_CLIENT_IP_HEADER;
  const name = raw === undefined ? '' : raw.trim().toLowerCase();
  if (!name && raw) warnUnknownHeader('(blank)', 'is set but blank, so it counts as unset. Remove it, or name the header');
  if (name) {
    if (name === 'none') return null;
    if (!KNOWN_HEADERS.has(name)) warnUnknownHeader(name);
    return name;
  }
  return process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME ? 'x-real-ip' : null;
}

/**
 * Client-address headers that real proxies set. A name outside this list is still used (a custom
 * proxy may have its own), but it is likely a typo, and a header no request carries sends every
 * post into the one shared fallback bucket, so the whole site would share one allowance.
 * X-Forwarded-For is left off on purpose: behind most proxies its first value is whatever the
 * client sent, so keying on it lets anyone pick a fresh address per post.
 */
const KNOWN_HEADERS = new Set([
  'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'fly-client-ip', 'x-client-ip',
  'x-cluster-client-ip', 'fastly-client-ip', 'x-azure-clientip',
]);
let warnedHeader = null;

function warnUnknownHeader(name, blank) {
  if (warnedHeader === name) return;
  warnedHeader = name;
  if (blank) {
    console.warn(`WARNING: OPEN_CLIENT_IP_HEADER ${blank}.`);
    return;
  }
  if (name === 'x-forwarded-for') {
    console.warn(
      'WARNING: OPEN_CLIENT_IP_HEADER is "x-forwarded-for". Behind most proxies its first value is ' +
        'whatever the client sent, so anyone can pick a fresh address per post and skip the limit. ' +
        'Use a header your proxy overwrites (on Railway, x-real-ip).'
    );
    return;
  }
  console.warn(
    `WARNING: OPEN_CLIENT_IP_HEADER is "${name}", which is not a header proxies usually set. ` +
      'If no request carries it, every post shares ONE rate-limit allowance for the whole site. ' +
      'Check the spelling, or set OPEN_CLIENT_IP_HEADER=none to use req.ip.'
  );
}

const net = require('net');

/** Every request whose address can't be trusted shares this one bucket. */
const FALLBACK_KEY = 'ip:fallback';

/**
 * A bucket name for one address: IPv4 as is (an IPv4-mapped IPv6 address counts as its IPv4),
 * IPv6 grouped by its /64, since one subscriber usually holds a whole /64 and could otherwise
 * rotate through it. Returns null when `raw` is not an IP address.
 */
function addressKey(raw) {
  const value = String(raw || '').trim();
  if (net.isIPv4(value)) return value;
  const bare = value.split('%')[0];
  if (!net.isIPv6(bare)) return null;
  let a = bare.toLowerCase();
  const tail4 = a.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail4) {
    const [b0, b1, b2, b3] = tail4.slice(2).map(Number);
    a = `${tail4[1]}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  let groups;
  if (a.includes('::')) {
    const [head, tail] = a.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  } else {
    groups = a.split(':');
  }
  const words = groups.map((g) => parseInt(g, 16));
  // IPv4-mapped (::ffff:0:0/96) in any spelling, dotted or hex, counts as its IPv4.
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return `${words.slice(0, 4).map((w) => w.toString(16)).join(':')}::/64`;
}

const loggedStates = new Set();

/** Logs each keying state once per process, by name only (never an address). */
function logState(state) {
  if (loggedStates.has(state)) return;
  loggedStates.add(state);
  console.log(`Post rate limit keyed by ${state}`);
}

/**
 * The rate-limit key for a REST request. With a trusted header configured, its first value when
 * that is a valid IP address. When the header is missing or holds something that isn't an
 * address, every such request shares one fallback bucket: behind Railway, req.ip is an internal
 * hop that changes per connection, so keying on it would give each request a fresh allowance.
 * With no header configured, req.ip, and the shared fallback if even that isn't an address.
 */
function clientKey(req) {
  const name = clientIpHeader();
  if (name) {
    const raw = req.get(name);
    if (raw === undefined || String(raw).trim() === '') {
      if (!KNOWN_HEADERS.has(name)) warnUnknownHeader(name);
      logState(`a shared fallback bucket (${name} missing)`);
      return FALLBACK_KEY;
    }
    const key = addressKey(String(raw).split(',')[0]);
    if (!key) {
      logState(`a shared fallback bucket (${name} not an IP address)`);
      return FALLBACK_KEY;
    }
    logState(name);
    return `ip:${key}`;
  }
  const key = addressKey(req.ip);
  if (!key) {
    logState('a shared fallback bucket (req.ip not an IP address)');
    return FALLBACK_KEY;
  }
  logState('req.ip');
  return `ip:${key}`;
}

const buckets = new Map();
/** Sweep full buckets at most this often once the map is large. */
const PRUNE_EVERY_MS = 10000;
let lastPruneAt = -Infinity;
let clock = () => Date.now();

/** Knobs whose bad value has already been warned about (name -> raw value), so it logs once. */
const warnedKnobs = new Map();

/**
 * A whole-number knob from the environment, at least `min` (0 means that rung is off where the
 * README says so). Anything else (a fraction, a negative, text, Infinity) falls back to the
 * default with one WARNING, since a value below one post can never refill to a whole post.
 */
function envNumber(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n >= min) return n;
  if (warnedKnobs.get(name) !== raw) {
    warnedKnobs.set(name, raw);
    console.warn(
      `[rate-limit] WARNING: ${name}=${JSON.stringify(raw)} is not a whole number >= ${min}; using the default ${fallback}.`
    );
  }
  return fallback;
}

/** Posts per minute one address may make across every key it holds (default 120, so people
 * sharing a NAT aren't held to one person's allowance). OPEN_POST_IP_RATE_PER_MIN tunes it. */
const DEFAULT_IP_PER_MIN = 120;
/** A newly minted key may post this many at once (OPEN_POST_NEW_KEY_BURST)... */
const DEFAULT_NEW_KEY_BURST = 5;
/** ...and its allowance grows evenly to the full per-key rate over this long (OPEN_POST_NEW_KEY_RAMP_MS). */
const DEFAULT_NEW_KEY_RAMP_MS = 10 * 60 * 1000;

function ipPerMinute() {
  return envNumber('OPEN_POST_IP_RATE_PER_MIN', DEFAULT_IP_PER_MIN);
}

/**
 * A key's allowance per minute at time t. A key with a known birth time starts at the new-key
 * burst and earns the full rate over the ramp, so minting keys buys little. bornAt null means an
 * established key: full rate.
 */
function allowance(limit, bornAt, t, knobs) {
  if (bornAt === null || bornAt === undefined || !Number.isFinite(bornAt)) return limit;
  const burst = knobs
    ? envNumber(knobs.burstName, knobs.burstDefault, 1)
    : envNumber('OPEN_POST_NEW_KEY_BURST', DEFAULT_NEW_KEY_BURST, 1);
  const ramp = knobs
    ? envNumber(knobs.rampName, knobs.rampDefault)
    : rampMs();
  if (burst >= limit || !ramp) return limit;
  const age = Math.max(0, t - bornAt);
  return Math.min(limit, burst + ((limit - burst) * age) / ramp);
}

/**
 * Keys minted by this process within the last ramp (key → ms). The join that mints a guest key or
 * an AI credential calls markNew; any key not here is established and gets the full rate, so a
 * restart never puts existing guests back on the ramp (a key minted just before a restart skips
 * the rest of its ramp, which is fine: the address ceiling still holds).
 */
const born = new Map();
/** Most keys tracked on the ramp at once (a flood of free joins can't grow it past this). */
const BORN_MAX = 50000;

function rampMs() {
  return envNumber('OPEN_POST_NEW_KEY_RAMP_MS', DEFAULT_NEW_KEY_RAMP_MS);
}

/**
 * Record that `key` was minted just now, so its posts start on the new-key ramp. A remint of a
 * key already on the ramp (an AI that leaves and joins the same room again) restarts the ramp and
 * its earn-out count from zero, so reminting never shortens the way to the full rate.
 */
function markNew(key) {
  const t = clock();
  // A Map iterates in insertion order and every entry is (re)inserted at its birth, so the oldest
  // births come first: drop expired ones from the front and stop at the first live one. Each entry
  // is dropped at most once, so a flood of joins costs O(1) each rather than a scan per join.
  // Drop expired births using the longer Open/AI ramp so an AI key mid-ramp is not
  // cleared early just because Open's window is shorter.
  const ramp = Math.max(
    rampMs(),
    envNumber('AI_POST_NEW_KEY_RAMP_MS', DEFAULT_AI_NEW_KEY_RAMP_MS),
    envNumber('HUMAN_POST_NEW_KEY_RAMP_MS', DEFAULT_HUMAN_NEW_KEY_RAMP_MS)
  );
  for (const [k, at] of born) {
    if (t - at < ramp) break;
    born.delete(k);
    earned.delete(k);
  }
  born.delete(key);
  earned.delete(key);
  born.set(key, t);
  // Hard bound: past BORN_MAX the oldest entries go first. Those keys then count as established,
  // at the per-key rate; the address ceiling still holds them.
  while (born.size > BORN_MAX) born.delete(born.keys().next().value);
}

/** When `key` was minted, if that was within `ramp` (default Open ramp); otherwise null. */
function bornAt(key, t, ramp = rampMs()) {
  const at = born.get(key);
  if (at === undefined) return null;
  if (t - at >= ramp) {
    born.delete(key);
    earned.delete(key);
    return null;
  }
  return at;
}

/** The bucket for one spec at time t, refilled but not yet charged. */
function refill(spec, t) {
  const cap = allowance(spec.limit, spec.bornAt, t, spec.rampKnobs);
  let b = buckets.get(spec.key);
  let created = false;
  if (!b) {
    // A full sweep at most every PRUNE_EVERY_MS, so a flood of new keys can't make every
    // request scan the whole map.
    if (buckets.size >= PRUNE_AT && t - lastPruneAt >= PRUNE_EVERY_MS) prune(t);
    b = { tokens: cap, at: t, limit: spec.limit };
    buckets.set(spec.key, b);
    created = true;
  } else {
    b.tokens = Math.min(cap, b.tokens + ((t - b.at) * cap) / 60000);
    b.at = t;
    b.limit = spec.limit;
  }
  return { key: spec.key, b, cap, created };
}

/**
 * Take one post from every bucket in `specs` ({ key, limit, bornAt? }), or from none of them.
 * Returns 0 when the post may go ahead, otherwise how many milliseconds until every bucket has a
 * post to spare. A spec whose limit is 0 is skipped (that rung is off).
 */
function take(specs) {
  const t = clock();
  const live = specs.filter((s) => s && s.limit > 0).map((s) => refill(s, t));
  let waitMs = 0;
  for (const { b, cap } of live) {
    if (b.tokens < 1) waitMs = Math.max(waitMs, Math.ceil(((1 - b.tokens) * 60000) / cap));
  }
  if (waitMs) {
    // A refused post leaves nothing behind: a bucket made just now for it is full anyway.
    for (const { key, created } of live) if (created) buckets.delete(key);
    return waitMs;
  }
  for (const { b } of live) b.tokens -= 1;
  return 0;
}

/**
 * Take one post from `key`'s bucket at the per-key rate (MCP connectors, which are configured by
 * the operator and so start at the full rate). Returns 0, or the wait in milliseconds.
 */
function takePost(key) {
  return take([{ key, limit: perMinute() }]);
}

/**
 * One Open post: the per-key bucket (a guest or an AI credential, at OPEN_POST_RATE_PER_MIN, keys
 * marked new ramping up) and the address ceiling above it (OPEN_POST_IP_RATE_PER_MIN), so a fresh
 * key from the same address doesn't buy a fresh allowance. Requests with no trustworthy address
 * share the fallback bucket, held to the per-key rate. OPEN_POST_RATE_PER_MIN=0 turns all of it off.
 */
function takeOpenPost(ipKey, key) {
  const limit = perMinute();
  if (!limit) return 0;
  const ipLimit = ipKey === FALLBACK_KEY ? limit : ipPerMinute();
  return take([
    { key: ipKey, limit: ipLimit },
    key ? { key, limit, bornAt: bornAt(key, clock()) } : null,
  ]);
}

/** Default Human live posts per minute for one guest key (humane for a fast typist). */
const DEFAULT_HUMAN_LIVE_PER_MIN = 45;
/** Default Human board posts per minute for one guest key. */
const DEFAULT_HUMAN_BOARD_PER_MIN = 20;
/** Default Human address ceiling across every key from one address. */
const DEFAULT_HUMAN_IP_PER_MIN = 120;
/** Default Human shared posts per minute into one room. */
const DEFAULT_HUMAN_ROOM_PER_MIN = 90;
/** A newly minted Human guest key may post this many at once. */
const DEFAULT_HUMAN_NEW_KEY_BURST = 8;
/** Human new-key allowance grows evenly to the full rate over this long. */
const DEFAULT_HUMAN_NEW_KEY_RAMP_MS = 10 * 60 * 1000;
/** Default writing Human joins per minute from one address. */
const DEFAULT_HUMAN_JOIN_PER_MIN = 10;
/** Default Human rejoins per minute for one guest key. */
const DEFAULT_HUMAN_REJOIN_PER_MIN = 30;
/** Default guestbook signatures per minute from one address. */
const DEFAULT_HUMAN_GUESTBOOK_PER_MIN = 3;
/** Default Human branch+merge calls per minute (per key, else per address). */
const DEFAULT_HUMAN_STRUCT_PER_MIN = 6;

const HUMAN_RAMP_KNOBS = {
  burstName: 'HUMAN_POST_NEW_KEY_BURST',
  burstDefault: DEFAULT_HUMAN_NEW_KEY_BURST,
  rampName: 'HUMAN_POST_NEW_KEY_RAMP_MS',
  rampDefault: DEFAULT_HUMAN_NEW_KEY_RAMP_MS,
};

/** Default AI posts per minute for one credential. */
const DEFAULT_AI_POST_PER_MIN = 120;
/** Default AI address ceiling across every credential from one address. */
const DEFAULT_AI_POST_IP_PER_MIN = 120;
/** Default AI shared posts per minute into one room. */
const DEFAULT_AI_POST_ROOM_PER_MIN = 240;
/** A newly minted AI credential may post this many at once. */
const DEFAULT_AI_NEW_KEY_BURST = 10;
/** AI new-credential allowance grows evenly to the full rate over this long. */
const DEFAULT_AI_NEW_KEY_RAMP_MS = 15 * 60 * 1000;
/** Accepted posts after which a new AI credential jumps to the full rate (0 = off). */
const DEFAULT_AI_EARN_OUT_POSTS = 50;
/** Default AI joins per minute from one address. */
const DEFAULT_AI_JOIN_IP_PER_MIN = 12;
/** Default AI joins per minute for one agent_id. */
const DEFAULT_AI_JOIN_AGENT_PER_MIN = 6;
/** Default Open joins per minute from one address (human and Open-composition AI). */
const DEFAULT_OPEN_JOIN_IP_PER_MIN = 12;
/** Default site-wide writing-join backstop shared by Open, /api/ai and Human. */
const DEFAULT_JOIN_SITE_PER_MIN = 300;

/** Accepted posts while a key is still on the AI new-credential ramp (key → count). */
const earned = new Map();

const AI_RAMP_KNOBS = {
  burstName: 'AI_POST_NEW_KEY_BURST',
  burstDefault: DEFAULT_AI_NEW_KEY_BURST,
  rampName: 'AI_POST_NEW_KEY_RAMP_MS',
  rampDefault: DEFAULT_AI_NEW_KEY_RAMP_MS,
};

/**
 * One Human post. With `key` (a `human:guest:…` base id): separate live/board buckets
 * (`key:live` / `key:board`) at HUMAN_LIVE_POST_RATE_PER_MIN (default 45) and
 * HUMAN_BOARD_POST_RATE_PER_MIN (default 20), under HUMAN_POST_IP_RATE_PER_MIN (default 120)
 * for the address, with new keys on the shared markNew ramp. Without `key`: address alone at
 * HUMAN_POST_RATE_PER_MIN (default 30; 0 turns that address-only path off), as #46 shipped.
 * A live/board/IP knob of 0 turns that keyed rung off. Live never falls back to HUMAN_POST_RATE_PER_MIN.
 */
function takeHumanPost(ipKey, key, { format, roomId } = {}) {
  if (!key) {
    return take([{ key: `human:${ipKey}`, limit: envNumber('HUMAN_POST_RATE_PER_MIN', DEFAULT_PER_MIN) }]);
  }
  // Live and board each get their own bucket so one format cannot refill or spend the other (QC H20 B-1).
  // bornAt is shared from the base key (markNew on mint) with Human burst/ramp knobs.
  // HUMAN_LIVE_POST_RATE_PER_MIN defaults to 45 on its own and never reads HUMAN_POST_RATE_PER_MIN.
  const fmt = format === 'live' ? 'live' : 'board';
  const perKey =
    fmt === 'live'
      ? envNumber('HUMAN_LIVE_POST_RATE_PER_MIN', DEFAULT_HUMAN_LIVE_PER_MIN)
      : envNumber('HUMAN_BOARD_POST_RATE_PER_MIN', DEFAULT_HUMAN_BOARD_PER_MIN);
  if (!perKey && ipKey === FALLBACK_KEY) return 0;
  const ipLimit =
    ipKey === FALLBACK_KEY
      ? perKey || envNumber('HUMAN_POST_RATE_PER_MIN', DEFAULT_PER_MIN)
      : envNumber('HUMAN_POST_IP_RATE_PER_MIN', DEFAULT_HUMAN_IP_PER_MIN);
  const roomLimit = envNumber('HUMAN_POST_ROOM_RATE_PER_MIN', DEFAULT_HUMAN_ROOM_PER_MIN);
  const humanRamp = envNumber('HUMAN_POST_NEW_KEY_RAMP_MS', DEFAULT_HUMAN_NEW_KEY_RAMP_MS);
  return take([
    { key: ipKey === FALLBACK_KEY ? `human:${FALLBACK_KEY}` : `human:${ipKey}`, limit: ipLimit },
    {
      key: `${key}:${fmt}`,
      limit: perKey,
      bornAt: bornAt(key, clock(), humanRamp),
      rampKnobs: HUMAN_RAMP_KNOBS,
    },
    roomId ? { key: `human:room:${roomId}`, limit: roomLimit } : null,
  ].filter((s) => s && s.limit > 0));
}

/**
 * One Human join that writes (mint, claim, or new seat). Per-address HUMAN_JOIN_RATE_PER_MIN
 * (default 10) plus siteJoinSpec() (JOIN_SITE_RATE_PER_MIN) in the same take() so a refusal
 * burns neither. When `guestId` is set, also charges HUMAN_REJOIN_RATE_PER_MIN (default 30).
 * Owned reseats must not call this. A knob of 0 turns that rung off.
 */
function takeHumanJoin(ipKey, guestId) {
  const joinLimit = envNumber('HUMAN_JOIN_RATE_PER_MIN', DEFAULT_HUMAN_JOIN_PER_MIN);
  return take(
    [
      {
        key: ipKey === FALLBACK_KEY ? 'human:join:' + FALLBACK_KEY : 'human:join:' + ipKey,
        limit: joinLimit,
      },
      siteJoinSpec(),
      guestId
        ? {
            key: 'human:rejoin:' + guestId,
            limit: envNumber('HUMAN_REJOIN_RATE_PER_MIN', DEFAULT_HUMAN_REJOIN_PER_MIN),
          }
        : null,
    ].filter((s) => s && s.limit > 0)
  );
}

/** Probe the rejoin bucket alone (tests). Prefer takeHumanJoin(ipKey, guestId). */
function takeHumanRejoin(guestId) {
  if (!guestId) return 0;
  return take([
    {
      key: `human:rejoin:${guestId}`,
      limit: envNumber('HUMAN_REJOIN_RATE_PER_MIN', DEFAULT_HUMAN_REJOIN_PER_MIN),
    },
  ].filter((s) => s.limit > 0));
}

/** One guestbook signature from an address. HUMAN_GUESTBOOK_RATE_PER_MIN (default 3). */
function takeHumanGuestbook(ipKey) {
  return take([
    {
      key: ipKey === FALLBACK_KEY ? 'human:guestbook:' + FALLBACK_KEY : 'human:guestbook:' + ipKey,
      limit: envNumber('HUMAN_GUESTBOOK_RATE_PER_MIN', DEFAULT_HUMAN_GUESTBOOK_PER_MIN),
    },
  ].filter((s) => s.limit > 0));
}

/**
 * One Human branch or merge. Per-key when guestId is set, else per address.
 * HUMAN_STRUCT_RATE_PER_MIN (default 6).
 */
function takeHumanStruct(ipKey, guestId) {
  const limit = envNumber('HUMAN_STRUCT_RATE_PER_MIN', DEFAULT_HUMAN_STRUCT_PER_MIN);
  if (!limit) return 0;
  const key = guestId
    ? `human:struct:guest:${guestId}`
    : ipKey === FALLBACK_KEY
      ? 'human:struct:' + FALLBACK_KEY
      : 'human:struct:' + ipKey;
  return take([{ key, limit }]);
}

/**
 * After an accepted AI post on a key still mid-ramp: count toward earn-out. Once the count
 * reaches AI_POST_EARN_OUT_POSTS, the key is established (full rate) even if ramp time remains.
 * AI_POST_EARN_OUT_POSTS=0 turns this rung off (time ramp only).
 */
function noteAiEarn(key) {
  if (!born.has(key)) return;
  const need = envNumber('AI_POST_EARN_OUT_POSTS', DEFAULT_AI_EARN_OUT_POSTS);
  if (!need) return;
  const n = (earned.get(key) || 0) + 1;
  if (n >= need) {
    born.delete(key);
    earned.delete(key);
    return;
  }
  earned.delete(key);
  earned.set(key, n);
  while (earned.size > BORN_MAX) earned.delete(earned.keys().next().value);
}

/**
 * One /api/ai post: per-credential bucket (AI_POST_RATE_PER_MIN, new keys on the AI markNew ramp
 * with optional earn-out), per-address ceiling (AI_POST_IP_RATE_PER_MIN), and per-room shared
 * budget (AI_POST_ROOM_RATE_PER_MIN). Fallback address shares one bucket at the per-credential
 * rate. AI_POST_RATE_PER_MIN=0 turns all of it off. Open-composition AI posts do not use this.
 */
function takeAiPost(ipKey, key, roomId) {
  const limit = envNumber('AI_POST_RATE_PER_MIN', DEFAULT_AI_POST_PER_MIN);
  if (!limit) return 0;
  const t = clock();
  const ramp = envNumber('AI_POST_NEW_KEY_RAMP_MS', DEFAULT_AI_NEW_KEY_RAMP_MS);
  const birth = key ? bornAt(key, t, ramp) : null;
  const ipLimit = ipKey === FALLBACK_KEY ? limit : envNumber('AI_POST_IP_RATE_PER_MIN', DEFAULT_AI_POST_IP_PER_MIN);
  const roomLimit = envNumber('AI_POST_ROOM_RATE_PER_MIN', DEFAULT_AI_POST_ROOM_PER_MIN);
  const waitMs = take(
    [
      { key: ipKey === FALLBACK_KEY ? 'aiapi:' + FALLBACK_KEY : 'aiapi:' + ipKey, limit: ipLimit },
      key ? { key, limit, bornAt: birth, rampKnobs: AI_RAMP_KNOBS } : null,
      roomId ? { key: 'aiapi:room:' + roomId, limit: roomLimit } : null,
    ].filter((s) => s && s.limit > 0)
  );
  if (!waitMs && key && birth !== null) noteAiEarn(key);
  return waitMs;
}

/** Shared site-wide writing-join backstop (Open + /api/ai + Human). */
function siteJoinSpec() {
  return { key: 'join:site', limit: envNumber('JOIN_SITE_RATE_PER_MIN', DEFAULT_JOIN_SITE_PER_MIN) };
}

/**
 * One /api/ai register or join that writes (fresh mint / reclaim). Per-address
 * AI_JOIN_IP_RATE_PER_MIN (default 12) and AI_JOIN_AGENT_RATE_PER_MIN (default 6) per agent_id
 * from one address, so joins from other addresses can't use up a named agent's budget (QC A2),
 * plus the site-wide JOIN_SITE_RATE_PER_MIN backstop in the same take() so a refusal burns no
 * other bucket. Idempotent Bearer re-joins (nothing written) must not call this. Fallback
 * address shares one bucket at the per-agent rate. A knob of 0 turns that rung off.
 */
function takeAiJoin(ipKey, agentId) {
  const agentLimit = envNumber('AI_JOIN_AGENT_RATE_PER_MIN', DEFAULT_AI_JOIN_AGENT_PER_MIN);
  const ipLimit =
    ipKey === FALLBACK_KEY
      ? agentLimit
      : envNumber('AI_JOIN_IP_RATE_PER_MIN', DEFAULT_AI_JOIN_IP_PER_MIN);
  return take(
    [
      { key: ipKey === FALLBACK_KEY ? 'aiapi:join:' + FALLBACK_KEY : 'aiapi:join:' + ipKey, limit: ipLimit },
      agentId ? { key: 'aiapi:join:agent:' + ipKey + ':' + agentId, limit: agentLimit } : null,
      siteJoinSpec(),
    ].filter((s) => s && s.limit > 0)
  );
}

/**
 * One Open join that writes (fresh mint / reclaim for human or Open-composition AI).
 * Per-address OPEN_JOIN_IP_RATE_PER_MIN (default 12) plus the site-wide JOIN_SITE_RATE_PER_MIN
 * backstop in the same take(). Open has no per-agent join knob: the fallback address is held
 * to AI_JOIN_AGENT_RATE_PER_MIN's default (6), and OPEN_JOIN_IP_RATE_PER_MIN=0 turns the
 * per-address rung off for known and fallback addresses alike. Idempotent rejoins must not
 * call this. A knob of 0 turns that rung off.
 */
function takeOpenJoin(ipKey) {
  const openIp = envNumber('OPEN_JOIN_IP_RATE_PER_MIN', DEFAULT_OPEN_JOIN_IP_PER_MIN);
  // Fallback: no per-agent Open knob — hold to AI agent default (6). Knob 0 turns this rung off.
  const ipLimit = ipKey === FALLBACK_KEY ? (openIp > 0 ? DEFAULT_AI_JOIN_AGENT_PER_MIN : 0) : openIp;
  return take(
    [
      { key: ipKey === FALLBACK_KEY ? 'open:join:' + FALLBACK_KEY : 'open:join:' + ipKey, limit: ipLimit },
      siteJoinSpec(),
    ].filter((s) => s && s.limit > 0)
  );
}

/** Drops buckets that have refilled completely (a full bucket behaves the same as a new one,
 * except for a key still ramping up, which keeps its bucket until it has). */
function prune(t) {
  lastPruneAt = t;
  for (const [k, b] of buckets) {
    if (b.tokens + ((t - b.at) * b.limit) / 60000 >= b.limit) buckets.delete(k);
  }
}

function _reset() {
  buckets.clear();
  born.clear();
  earned.clear();
  warnedKnobs.clear();
  lastPruneAt = -Infinity;
  loggedStates.clear();
  warnedHeader = null;
  clock = () => Date.now();
}

function _setClock(fn) {
  clock = fn;
}

/** Map sizes, for tests. */
function _sizes() {
  return { buckets: buckets.size, born: born.size, earned: earned.size };
}

/**
 * Read every rate knob once through envNumber so a bad value warns in the boot log,
 * not only the first time a post hits that rung. Each bad knob still warns once per process.
 */
function checkKnobs() {
  envNumber('OPEN_POST_RATE_PER_MIN', DEFAULT_PER_MIN);
  envNumber('OPEN_POST_IP_RATE_PER_MIN', DEFAULT_IP_PER_MIN);
  envNumber('OPEN_POST_NEW_KEY_BURST', DEFAULT_NEW_KEY_BURST, 1);
  envNumber('OPEN_POST_NEW_KEY_RAMP_MS', DEFAULT_NEW_KEY_RAMP_MS);
  envNumber('HUMAN_POST_RATE_PER_MIN', DEFAULT_PER_MIN);
  envNumber('HUMAN_LIVE_POST_RATE_PER_MIN', DEFAULT_HUMAN_LIVE_PER_MIN);
  envNumber('HUMAN_BOARD_POST_RATE_PER_MIN', DEFAULT_HUMAN_BOARD_PER_MIN);
  envNumber('HUMAN_POST_IP_RATE_PER_MIN', DEFAULT_HUMAN_IP_PER_MIN);
  envNumber('HUMAN_POST_ROOM_RATE_PER_MIN', DEFAULT_HUMAN_ROOM_PER_MIN);
  envNumber('HUMAN_POST_NEW_KEY_BURST', DEFAULT_HUMAN_NEW_KEY_BURST, 1);
  envNumber('HUMAN_POST_NEW_KEY_RAMP_MS', DEFAULT_HUMAN_NEW_KEY_RAMP_MS);
  envNumber('HUMAN_JOIN_RATE_PER_MIN', DEFAULT_HUMAN_JOIN_PER_MIN);
  envNumber('HUMAN_REJOIN_RATE_PER_MIN', DEFAULT_HUMAN_REJOIN_PER_MIN);
  envNumber('HUMAN_GUESTBOOK_RATE_PER_MIN', DEFAULT_HUMAN_GUESTBOOK_PER_MIN);
  envNumber('HUMAN_STRUCT_RATE_PER_MIN', DEFAULT_HUMAN_STRUCT_PER_MIN);
  envNumber('AI_POST_RATE_PER_MIN', DEFAULT_AI_POST_PER_MIN);
  envNumber('AI_POST_IP_RATE_PER_MIN', DEFAULT_AI_POST_IP_PER_MIN);
  envNumber('AI_POST_ROOM_RATE_PER_MIN', DEFAULT_AI_POST_ROOM_PER_MIN);
  envNumber('AI_POST_NEW_KEY_BURST', DEFAULT_AI_NEW_KEY_BURST, 1);
  envNumber('AI_POST_NEW_KEY_RAMP_MS', DEFAULT_AI_NEW_KEY_RAMP_MS);
  envNumber('AI_POST_EARN_OUT_POSTS', DEFAULT_AI_EARN_OUT_POSTS);
  envNumber('AI_JOIN_IP_RATE_PER_MIN', DEFAULT_AI_JOIN_IP_PER_MIN);
  envNumber('AI_JOIN_AGENT_RATE_PER_MIN', DEFAULT_AI_JOIN_AGENT_PER_MIN);
  envNumber('OPEN_JOIN_IP_RATE_PER_MIN', DEFAULT_OPEN_JOIN_IP_PER_MIN);
  envNumber('JOIN_SITE_RATE_PER_MIN', DEFAULT_JOIN_SITE_PER_MIN);
}

// Check the configured header at startup, so a typo warns in the boot log before the first post.
clientIpHeader();

module.exports = {
  _sizes,
  takePost,
  takeOpenPost,
  takeHumanPost,
  takeHumanJoin,
  takeHumanRejoin,
  takeHumanGuestbook,
  takeHumanStruct,
  takeAiPost,
  takeAiJoin,
  takeOpenJoin,
  siteJoinSpec,
  markNew,
  allowance,
  clientKey,
  clientIpHeader,
  checkKnobs,
  addressKey,
  FALLBACK_KEY,
  KNOWN_HEADERS,
  DEFAULT_PER_MIN,
  DEFAULT_IP_PER_MIN,
  DEFAULT_NEW_KEY_BURST,
  DEFAULT_NEW_KEY_RAMP_MS,
  DEFAULT_HUMAN_LIVE_PER_MIN,
  DEFAULT_HUMAN_BOARD_PER_MIN,
  DEFAULT_HUMAN_IP_PER_MIN,
  DEFAULT_HUMAN_ROOM_PER_MIN,
  DEFAULT_HUMAN_NEW_KEY_BURST,
  DEFAULT_HUMAN_NEW_KEY_RAMP_MS,
  DEFAULT_HUMAN_JOIN_PER_MIN,
  DEFAULT_HUMAN_REJOIN_PER_MIN,
  DEFAULT_HUMAN_GUESTBOOK_PER_MIN,
  DEFAULT_HUMAN_STRUCT_PER_MIN,
  DEFAULT_AI_POST_PER_MIN,
  DEFAULT_AI_POST_IP_PER_MIN,
  DEFAULT_AI_POST_ROOM_PER_MIN,
  DEFAULT_AI_NEW_KEY_BURST,
  DEFAULT_AI_NEW_KEY_RAMP_MS,
  DEFAULT_AI_EARN_OUT_POSTS,
  DEFAULT_AI_JOIN_IP_PER_MIN,
  DEFAULT_AI_JOIN_AGENT_PER_MIN,
  DEFAULT_OPEN_JOIN_IP_PER_MIN,
  DEFAULT_JOIN_SITE_PER_MIN,
  _reset,
  _setClock,
  _buckets: buckets,
};
