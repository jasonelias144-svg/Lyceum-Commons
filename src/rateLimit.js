/**
 * Post rate limit (R12-1b). Messages persist and every restart reads them all back, so one client
 * posting without pause makes every later boot slower. Each key (a client address for the REST API,
 * a connector for MCP) gets a bucket of OPEN_POST_RATE_PER_MIN posts (default 30) that refills
 * evenly over a minute. OPEN_POST_RATE_PER_MIN=0 turns the limit off.
 */
const DEFAULT_PER_MIN = 30;
/** Buckets that have refilled completely are dropped once there are this many keys. */
const PRUNE_AT = 10000;

function perMinute() {
  const raw = process.env.OPEN_POST_RATE_PER_MIN;
  if (raw === undefined || raw === '') return DEFAULT_PER_MIN;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PER_MIN;
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
let clock = () => Date.now();

/**
 * Take one post from `key`'s bucket. Returns 0 when the post may go ahead, otherwise how many
 * milliseconds until the next one is allowed.
 */
function takePost(key) {
  const limit = perMinute();
  if (!limit) return 0;
  const t = clock();
  const msPerPost = 60000 / limit;
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= PRUNE_AT) prune(t, limit, msPerPost);
    b = { tokens: limit, at: t };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(limit, b.tokens + (t - b.at) / msPerPost);
    b.at = t;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return 0;
  }
  return Math.ceil((1 - b.tokens) * msPerPost);
}

function prune(t, limit, msPerPost) {
  for (const [k, b] of buckets) {
    if (b.tokens + (t - b.at) / msPerPost >= limit) buckets.delete(k);
  }
}

function _reset() {
  buckets.clear();
  loggedStates.clear();
  warnedHeader = null;
  clock = () => Date.now();
}

function _setClock(fn) {
  clock = fn;
}

// Check the configured header at startup, so a typo warns in the boot log before the first post.
clientIpHeader();

module.exports = { takePost, clientKey, clientIpHeader, addressKey, FALLBACK_KEY, KNOWN_HEADERS, DEFAULT_PER_MIN, _reset, _setClock, _buckets: buckets };
