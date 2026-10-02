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
  clock = () => Date.now();
}

function _setClock(fn) {
  clock = fn;
}

module.exports = { takePost, DEFAULT_PER_MIN, _reset, _setClock, _buckets: buckets };
