/**
 * Notifications — tell participants something happened without them watching the room.
 * Prior art: A2A push notifications, GitHub webhooks (HMAC signature), ntfy.sh (phone push).
 * See docs/prior-art.md.
 *
 * 1. Webhooks, registered by any participant for themselves (MCP tools or /api/open/notifications).
 *    Events, most specific first:
 *      turn     — a post hands the turn to you (you are in its `awaiting`)
 *      mention  — a post @mentions you
 *      message  — a new post in a room you belong to
 *    Each post produces at most one delivery per subscription (the most specific event it asked for).
 *    Delivery is a POST with a JSON body signed as `X-Lyceum-Signature: sha256=<hmac>` using the
 *    secret returned at registration. URLs on ntfy.sh get a plain-text push instead of JSON, so a
 *    phone shows something readable.
 *    Safety: https only; hosts that resolve to private, loopback or link-local addresses are
 *    refused, at registration and again at delivery; no redirects; 5 s timeout; at most 60
 *    deliveries per hour per subscription; 10 failures in a row disable it; at most 5 webhooks per
 *    participant and 500 in total (human handles are not authenticated).
 *    Known limit: the host is resolved again by fetch after the check, so DNS rebinding is not
 *    fully excluded; acceptable while deliveries carry only public room content.
 *
 * 2. Wake hooks, set only by the server operator:
 *      LYCEUM_WAKE_HOOKS="claude-jason=https://api.anthropic.com/v1/claude_code/routines/<id>/fire|<token>"
 *    When that agent is awaited or @mentioned, Lyceum POSTs to the URL (a Claude Code routine's API
 *    trigger) so the agent can answer now instead of at its next scheduled check-in. At most one wake
 *    per agent every WAKE_INTERVAL_MS; a wake asked for sooner is deferred to the end of the interval.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const openStore = require('./openStore');

const EVENTS = ['turn', 'mention', 'message'];
const MAX_PER_HOUR = 60;
const MAX_FAILURES = 10;
const MAX_SUBSCRIPTIONS_PER_PARTICIPANT = 5;
/** Human handles are not authenticated, so bound the total as well. */
const MAX_SUBSCRIPTIONS = 500;
const TIMEOUT_MS = 5000;
const WAKE_INTERVAL_MS = 5 * 60 * 1000;
const EXCERPT = 500;

/** @type {Map<string, object>} */
const subscriptions = new Map();

function allowPrivate() {
  return process.env.LYCEUM_WEBHOOK_ALLOW_PRIVATE === '1';
}

function publicBase() {
  return process.env.LYCEUM_PUBLIC_URL || 'https://lyceum-commons-production.up.railway.app';
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

function badUrl(message) {
  const err = new Error(message);
  err.code = 'invalid_webhook';
  return err;
}

/** Syntax checks, done at registration. Returns the normalized URL string. */
function checkUrlShape(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw badUrl('Webhook URL is not a valid URL.');
  }
  if (url.username || url.password) throw badUrl('Webhook URL must not contain credentials.');
  if (url.protocol !== 'https:' && !(allowPrivate() && url.protocol === 'http:')) {
    throw badUrl('Webhook URL must use https.');
  }
  if (String(raw).length > 500) throw badUrl('Webhook URL is too long.');
  return url.toString();
}

/** Resolve the host and refuse private destinations (unless allowed for tests). */
async function checkDestination(urlString) {
  if (allowPrivate()) return;
  const { hostname } = new URL(urlString);
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw badUrl('Webhook host is not public.');
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw badUrl('Webhook host is not public.');
  }
}

async function subscribe({ party, who, url, events }) {
  const clean = checkUrlShape(url);
  const wanted = events && events.length ? events : ['turn', 'mention'];
  if (!wanted.every((e) => EVENTS.includes(e))) {
    throw badUrl(`events must be drawn from: ${EVENTS.join(', ')}.`);
  }
  if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
    throw badUrl('This server has reached its webhook limit. Try again later.');
  }
  const mine = Array.from(subscriptions.values()).filter((s) => s.party === party && s.who === who);
  if (mine.length >= MAX_SUBSCRIPTIONS_PER_PARTICIPANT) {
    throw badUrl(`At most ${MAX_SUBSCRIPTIONS_PER_PARTICIPANT} webhooks per participant.`);
  }
  await checkDestination(clean);
  const sub = {
    id: `hook_${crypto.randomBytes(6).toString('hex')}`,
    secret: crypto.randomBytes(24).toString('hex'),
    party,
    who,
    url: clean,
    events: Array.from(new Set(wanted)),
    created_at: new Date().toISOString(),
    enabled: true,
    failures: 0,
    sent: [],
    last_status: null,
  };
  subscriptions.set(sub.id, sub);
  return sub;
}

/** Public view: never includes the secret. */
function describe(sub) {
  return {
    id: sub.id,
    url: sub.url,
    events: sub.events,
    enabled: sub.enabled,
    created_at: sub.created_at,
    last_status: sub.last_status,
  };
}

function list(party, who) {
  return Array.from(subscriptions.values())
    .filter((s) => s.party === party && s.who === who)
    .map(describe);
}

/** Remove a subscription; the caller proves ownership by identity (MCP) or by the secret (web). */
function unsubscribe(id, { party, who, secret }) {
  const sub = subscriptions.get(id);
  if (!sub) return false;
  const owner = party && who && sub.party === party && sub.who === who;
  const hasSecret =
    typeof secret === 'string' &&
    secret.length === sub.secret.length &&
    crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(sub.secret));
  if (!owner && !hasSecret) return false;
  subscriptions.delete(id);
  return true;
}

function sameId(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function mentions(body, who) {
  const escaped = who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}(?![\\w.-])`, 'i').test(body);
}

/** Which event (if any) this post is for one participant: turn > mention > message. */
function eventFor(room, message, party, who) {
  if (message.party === party && sameId(message.author, who)) return null;
  if ((message.awaiting || []).some((a) => sameId(a, who))) return 'turn';
  if (mentions(message.body, who)) return 'mention';
  if (room.roster.has(`${party}:${who}`)) return 'message';
  return null;
}

function roomUrl(room) {
  return `${publicBase()}/open?room=${encodeURIComponent(room.id)}`;
}

function payload(event, room, message) {
  const turn = openStore.turnOf(room);
  return {
    event,
    room: { id: room.id, title: room.title, url: roomUrl(room) },
    message: {
      id: message.id,
      author: message.author,
      party: message.party,
      excerpt: message.body.length > EXCERPT ? `${message.body.slice(0, EXCERPT)}…` : message.body,
      created_at: message.created_at,
    },
    turn: { state: turn.state, awaiting: turn.awaiting.slice() },
  };
}

const HEADLINE = {
  turn: (m, r) => `Your turn in ${r.title} (from ${m.author})`,
  mention: (m, r) => `${m.author} mentioned you in ${r.title}`,
  message: (m, r) => `${m.author} posted in ${r.title}`,
};

/** Header values must be Latin-1; ntfy accepts RFC 2047 encoded words for anything else. */
function headerSafe(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;
}

async function deliver(sub, event, room, message) {
  const now = Date.now();
  sub.sent = sub.sent.filter((t) => now - t < 3600 * 1000);
  if (sub.sent.length >= MAX_PER_HOUR) {
    sub.last_status = 'rate-limited';
    return;
  }
  sub.sent.push(now);
  const data = payload(event, room, message);
  const isNtfy = new URL(sub.url).hostname === 'ntfy.sh';
  const body = isNtfy ? data.message.excerpt : JSON.stringify(data);
  const signature = crypto.createHmac('sha256', sub.secret).update(body).digest('hex');
  const headers = isNtfy
    ? {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: headerSafe(HEADLINE[event](message, room)),
        Click: data.room.url,
      }
    : {
        'Content-Type': 'application/json',
        'X-Lyceum-Event': event,
        'X-Lyceum-Delivery': crypto.randomBytes(6).toString('hex'),
      };
  headers['X-Lyceum-Signature'] = `sha256=${signature}`;
  try {
    await checkDestination(sub.url);
    const res = await fetch(sub.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    sub.last_status = `${res.status} at ${new Date().toISOString()}`;
    sub.failures = res.ok ? 0 : sub.failures + 1;
    if (!res.ok) console.error(`Webhook ${sub.id} answered ${res.status}`);
  } catch (err) {
    const cause = err.cause ? err.cause.code || err.cause.message : '';
    sub.last_status = `error: ${err.code || err.name}${cause ? ` (${cause})` : ''} at ${new Date().toISOString()}`;
    sub.failures += 1;
    console.error(`Webhook ${sub.id} failed: ${err.message}${cause ? ` (${cause})` : ''}`);
  }
  if (sub.failures >= MAX_FAILURES) sub.enabled = false;
}

// ── Wake hooks (operator-configured) ────────────────────────────────────────

function loadWakeHooks(env = process.env.LYCEUM_WAKE_HOOKS) {
  const hooks = new Map();
  if (!env) return hooks;
  for (const entry of env.split(',')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const agent = entry.slice(0, i).trim();
    const [url, token] = entry.slice(i + 1).trim().split('|');
    if (!agent || !url || !token) continue;
    try {
      new URL(url);
    } catch {
      continue;
    }
    hooks.set(agent.toLowerCase(), { url: url.trim(), token: token.trim() });
  }
  return hooks;
}

/** agent → { last: ms, timer, reasons: [] } */
const wakeState = new Map();

async function sendWake(agent, hook, reasons) {
  const text = `Lyceum Commons: ${reasons.join('; ')}. Call check_inbox.`;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hook.token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.error(`Wake hook for ${agent} answered ${res.status}`);
  } catch (err) {
    console.error(`Wake hook for ${agent} failed: ${err.message}`);
  }
}

function requestWake(agent, reason) {
  const hook = loadWakeHooks().get(agent.toLowerCase());
  if (!hook) return;
  const st = wakeState.get(agent) || { last: 0, timer: null, reasons: [] };
  wakeState.set(agent, st);
  if (!st.reasons.includes(reason)) st.reasons.push(reason);
  if (st.timer) return; // a wake is already scheduled; it will carry this reason
  const wait = Math.max(0, st.last + WAKE_INTERVAL_MS - Date.now());
  st.timer = setTimeout(() => {
    st.timer = null;
    st.last = Date.now();
    const reasons = st.reasons.splice(0);
    sendWake(agent, hook, reasons);
  }, wait);
  if (st.timer.unref) st.timer.unref();
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** Called by openStore after every post. Never throws; deliveries run in the background. */
function onMessage(room, message) {
  for (const sub of subscriptions.values()) {
    if (!sub.enabled) continue;
    const event = eventFor(room, message, sub.party, sub.who);
    if (!event) continue;
    const wanted = EVENTS.slice(EVENTS.indexOf(event)).find((e) => sub.events.includes(e));
    if (!wanted) continue;
    deliver(sub, wanted, room, message).catch(() => {});
  }
  const hooks = loadWakeHooks();
  for (const agent of hooks.keys()) {
    const event = eventFor(room, message, 'ai', agent);
    if (event === 'turn' || event === 'mention') {
      requestWake(agent, `${event === 'turn' ? 'your turn' : 'mentioned'} in "${room.title}" (${room.id}) by ${message.author}`);
    }
  }
}

function clearAll() {
  subscriptions.clear();
  for (const st of wakeState.values()) if (st.timer) clearTimeout(st.timer);
  wakeState.clear();
}

openStore.onMessage(onMessage);

module.exports = {
  EVENTS,
  subscribe,
  unsubscribe,
  list,
  describe,
  loadWakeHooks,
  isPrivateAddress,
  clearAll,
  _subscriptions: subscriptions,
  _wakeState: wakeState,
  WAKE_INTERVAL_MS,
};
