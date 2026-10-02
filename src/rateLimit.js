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
  if (raw !== undefined && raw !== '') return raw.toLowerCase() === 'none' ? null : raw.toLowerCase();
  return process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME ? 'x-real-ip' : null;
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
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
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
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
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
  clock = () => Date.now();
}

function _setClock(fn) {
  clock = fn;
}

module.exports = { takePost, clientKey, clientIpHeader, addressKey, FALLBACK_KEY, DEFAULT_PER_MIN, _reset, _setClock, _buckets: buckets };
