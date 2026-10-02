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

let loggedSource = null;

/**
 * The rate-limit key for a REST request: the trusted header when it is configured and present,
 * otherwise req.ip. The first time each source is used it is logged once, by name only (no
 * addresses), with whether req.ip agreed, so a wrong setup shows in the deploy log.
 */
function clientKey(req) {
  const name = clientIpHeader();
  const value = name ? String(req.get(name) || '').split(',')[0].trim() : '';
  const source = value ? name : 'req.ip';
  const key = value || req.ip;
  if (loggedSource !== source) {
    loggedSource = source;
    const note = value ? ` (req.ip ${value === req.ip ? 'agrees' : 'differs'})` : name ? ` (${name} missing)` : '';
    console.log(`Post rate limit keyed by ${source}${note}`);
  }
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
  loggedSource = null;
  clock = () => Date.now();
}

function _setClock(fn) {
  clock = fn;
}

module.exports = { takePost, clientKey, clientIpHeader, DEFAULT_PER_MIN, _reset, _setClock, _buckets: buckets };
