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
 *    secret returned at registration. URLs on ntfy servers (ntfy.sh, ntfy.<domain>) get a plain-text push, so a
 *    phone shows something readable.
 *    Safety: https only; hosts that resolve to private, loopback or link-local addresses are
 *    refused, at registration and again at delivery; IPv4 only; no redirects; 5 s timeout; at most 60
 *    deliveries per hour per subscription; 10 failures in a row disable it; at most 5 webhooks per
 *    participant and 500 in total (human handles are not authenticated).
 *    Known limit: the host is resolved again by fetch after the check, so DNS rebinding is not
 *    fully excluded; acceptable while deliveries carry only public room content.
 *
 * 1b. Web Push (the browser's own notifications, incl. iPhone home-screen web apps):
 *    subscribeWebPush() stores a PushSubscription from the Open page. Endpoints must belong to a
 *    known push service (Apple, Google, Mozilla, Microsoft). Payloads are encrypted and signed with
 *    this server's VAPID keys: LYCEUM_VAPID_PUBLIC_KEY / LYCEUM_VAPID_PRIVATE_KEY, else keys kept in
 *    the data directory (generated once), else in memory. A 404/410 from the push service means the
 *    device unsubscribed; the subscription is dropped.
 *
 * 2. Wake hooks, set only by the server operator:
 *      LYCEUM_WAKE_HOOKS="claude-jason=https://api.anthropic.com/v1/claude_code/routines/<id>/fire|<token>,grok-jason=<Grok automation webhook URL>"
 *    Anthropic routine URLs need their token; any other URL (e.g. a Grok Automation webhook) gets a
 *    plain JSON event { source, agent, text, reasons, inbox }, with an optional |token sent as Bearer.
 *    When that agent is awaited or @mentioned, Lyceum POSTs to the URL (a Claude Code routine's API
 *    trigger) so the agent can answer now instead of at its next scheduled check-in. At most one wake
 *    per agent every WAKE_INTERVAL_MS; a wake asked for sooner is deferred to the end of the interval.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const fs = require('fs');
const net = require('net');
const path = require('path');
const webpush = require('web-push');
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

/**
 * POST with Node's own client, pinned to IPv4. Railway has no IPv6 egress, and fetch's
 * happy-eyeballs attempts time out there on hosts that also publish IPv6 (e.g. ntfy.sh).
 * Redirects are not followed. Resolves { status, ok }.
 */
function postIPv4(urlString, headers, body) {
  const url = new URL(urlString);
  const client = url.protocol === 'http:' ? http : https;
  const data = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      { method: 'POST', family: 4, headers: { ...headers, 'Content-Length': data.length }, timeout: TIMEOUT_MS },
      (res) => {
        // Keep the start of the reply: when a receiver refuses a call, its reason is in the body.
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (text.length < 400) text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: text.slice(0, 400) })
        );
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
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

/** ntfy.sh and other public ntfy servers (ntfy.envs.net, …): send a readable phone push, not JSON. */
function isNtfyHost(hostname) {
  return hostname === 'ntfy.sh' || hostname.startsWith('ntfy.');
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
  const isNtfy = isNtfyHost(new URL(sub.url).hostname);
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
    const res = await postIPv4(sub.url, headers, body);
    sub.last_status = `${res.status} at ${new Date().toISOString()}`;
    sub.failures = res.ok ? 0 : sub.failures + 1;
    if (!res.ok) console.error(`Webhook ${sub.id} answered ${res.status}: ${res.text.replace(/\s+/g, ' ')}`);
  } catch (err) {
    const cause = err.cause ? err.cause.code || err.cause.message : err.code || '';
    sub.last_status = `error: ${err.code || err.name}${cause ? ` (${cause})` : ''} at ${new Date().toISOString()}`;
    sub.failures += 1;
    console.error(`Webhook ${sub.id} failed: ${err.message}${cause ? ` (${cause})` : ''}`);
  }
  if (sub.failures >= MAX_FAILURES) sub.enabled = false;
}

// ── Web Push ────────────────────────────────────────────────────────────────

const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
let vapid = null;

function vapidKeys() {
  if (vapid) return vapid;
  if (process.env.LYCEUM_VAPID_PUBLIC_KEY && process.env.LYCEUM_VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.LYCEUM_VAPID_PUBLIC_KEY, privateKey: process.env.LYCEUM_VAPID_PRIVATE_KEY };
    return vapid;
  }
  const dir = process.env.LYCEUM_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const file = dir ? path.join(dir, 'lyceum-vapid.json') : null;
  if (file && fs.existsSync(file)) {
    vapid = JSON.parse(fs.readFileSync(file, 'utf8'));
    return vapid;
  }
  vapid = webpush.generateVAPIDKeys();
  if (file) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(vapid), { mode: 0o600 });
  }
  return vapid;
}

function checkPushSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || !sub.keys) {
    throw badUrl('subscription must be a PushSubscription (endpoint and keys).');
  }
  const { p256dh, auth } = sub.keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
    throw badUrl('subscription keys are missing or malformed.');
  }
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    throw badUrl('subscription endpoint is not a URL.');
  }
  if (url.protocol !== 'https:' || sub.endpoint.length > 1000 || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw badUrl('subscription endpoint is not a known push service.');
  }
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

/** Store (or replace, for the same device endpoint) a Web Push subscription. */
function subscribeWebPush({ party, who, subscription, events }) {
  const push = checkPushSubscription(subscription);
  const wanted = events && events.length ? events : ['turn', 'mention'];
  if (!wanted.every((e) => EVENTS.includes(e))) throw badUrl(`events must be drawn from: ${EVENTS.join(', ')}.`);
  for (const [id, s] of subscriptions) {
    if (s.push && s.push.endpoint === push.endpoint) subscriptions.delete(id);
  }
  if (subscriptions.size >= MAX_SUBSCRIPTIONS) throw badUrl('This server has reached its webhook limit. Try again later.');
  const mine = Array.from(subscriptions.values()).filter((s) => s.party === party && s.who === who);
  if (mine.length >= MAX_SUBSCRIPTIONS_PER_PARTICIPANT) {
    throw badUrl(`At most ${MAX_SUBSCRIPTIONS_PER_PARTICIPANT} notification targets per participant.`);
  }
  const sub = {
    id: `hook_${crypto.randomBytes(6).toString('hex')}`,
    secret: crypto.randomBytes(24).toString('hex'),
    party,
    who,
    kind: 'webpush',
    url: `${new URL(push.endpoint).origin}/…`,
    push,
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

const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });
let sendWebPush = (push, body, options) => webpush.sendNotification(push, body, options);

async function deliverWebPush(sub, event, room, message) {
  const text = message.body.replace(/\s+/g, ' ').trim();
  const body = JSON.stringify({
    title: HEADLINE[event](message, room),
    body: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    url: roomUrl(room),
    tag: `lyceum-${room.id}`,
  });
  const keys = vapidKeys();
  try {
    const res = await sendWebPush(sub.push, body, {
      TTL: 24 * 3600,
      urgency: event === 'message' ? 'normal' : 'high',
      timeout: TIMEOUT_MS,
      agent: ipv4Agent,
      vapidDetails: { subject: publicBase(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    });
    sub.last_status = `${(res && res.statusCode) || 201} at ${new Date().toISOString()}`;
    sub.failures = 0;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      subscriptions.delete(sub.id); // the device unsubscribed or the subscription expired
      return;
    }
    sub.last_status = `error: ${err.statusCode || err.code || err.name} at ${new Date().toISOString()}`;
    sub.failures += 1;
    console.error(`Web push ${sub.id} failed: ${err.statusCode || ''} ${err.body || err.message}`);
    if (sub.failures >= MAX_FAILURES) sub.enabled = false;
  }
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
    if (!agent || !url) continue;
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      continue;
    }
    const anthropic = parsed.hostname === 'api.anthropic.com';
    if (anthropic && !token) continue; // routine triggers always need their token
    hooks.set(agent.toLowerCase(), { url: url.trim(), token: token ? token.trim() : null, anthropic });
  }
  return hooks;
}

/** agent → { last: ms, timer, reasons: [] } */
const wakeState = new Map();

async function sendWake(agent, hook, reasons) {
  const text = `Lyceum Commons: ${reasons.join('; ')}. Call check_inbox.`;
  // Claude Code routines take { text } with Anthropic headers; any other webhook (e.g. a Grok
  // Automation's webhook trigger) gets a plain JSON event, with the token as a Bearer if one is set.
  const headers = hook.anthropic
    ? {
        Authorization: `Bearer ${hook.token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      }
    : { 'Content-Type': 'application/json', ...(hook.token ? { Authorization: `Bearer ${hook.token}` } : {}) };
  const body = hook.anthropic
    ? JSON.stringify({ text })
    : JSON.stringify({ source: 'lyceum-commons', agent, text, reasons, inbox: `${publicBase()}/mcp` });
  try {
    const res = await postIPv4(hook.url, headers, body);
    if (!res.ok) console.error(`Wake hook for ${agent} answered ${res.status}: ${res.text.replace(/\s+/g, ' ')}`);
    else console.log(`Wake hook for ${agent} answered ${res.status}`);
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
    (sub.push ? deliverWebPush : deliver)(sub, wanted, room, message).catch(() => {});
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
  subscribeWebPush,
  vapidPublicKey: () => vapidKeys().publicKey,
  _setWebPushSender: (fn) => {
    sendWebPush = fn;
  },
  isPrivateAddress,
  isNtfyHost,
  clearAll,
  _subscriptions: subscriptions,
  _wakeState: wakeState,
  WAKE_INTERVAL_MS,
};
