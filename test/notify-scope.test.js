/**
 * Notification leak stopgap: every subscription belongs to one room, needs that name present
 * in that room to register, hears only that room, and is dropped when the name leaves.
 * Subscriptions from before this rule (no room) are dropped on restore and never delivered.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const { guestHeaders, remember, keyFor } = require('./guest-jar');
const assert = require('node:assert/strict');
const http = require('http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const openStore = require('../src/openStore');
const notify = require('../src/notify');
const persist = require('../src/persist');

const CLAUDE_KEY = 'claude-scope-key-0123456789abcdef';
let server;
let base;
let receiver;
let hookBase;
let received = [];
let pushed = [];

function waitFor(pred, ms = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}
const settle = () => new Promise((r) => setTimeout(r, 150));

before(async () => {
  process.env.LYCEUM_MCP_KEYS = `claude-test=${CLAUDE_KEY}`;
  process.env.LYCEUM_WEBHOOK_ALLOW_PRIVATE = '1';
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookBase = `http://127.0.0.1:${receiver.address().port}`;
  const app = require('../src/server');
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

after(async () => {
  delete process.env.LYCEUM_MCP_KEYS;
  delete process.env.LYCEUM_WEBHOOK_ALLOW_PRIVATE;
  notify.clearAll();
  await new Promise((r) => server.close(r));
  await new Promise((r) => receiver.close(r));
});

beforeEach(() => {
  openStore.clearAll();
  notify.clearAll();
  received = [];
  pushed = [];
  notify._setWebPushSender(async (push, body) => {
    pushed.push({ endpoint: push.endpoint, ...JSON.parse(body) });
    return { statusCode: 201 };
  });
});

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...guestHeaders(path, body, headers), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  remember(path, body, data);
  return { status: res.status, data };
}

async function roomWith(title, ...handles) {
  const id = (await json('POST', '/api/open/rooms', { title, visibility: 'unlisted' })).data.room_id;
  for (const h of handles) await json('POST', `/api/open/rooms/${id}/join`, { handle: h, party: 'human' });
  return id;
}

const device = (name) => ({ endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: 'BPk3yK0test', auth: 'authsecret' } });

describe('notification scope (leak stopgap)', () => {
  it('refuses to register without a room, for an unknown room, or for a name not present there', async () => {
    const secret = await roomWith('Private', 'jason');
    const noRoom = await json('POST', '/api/open/notifications', { handle: 'jason', url: `${hookBase}/x`, events: ['message'] });
    assert.equal(noRoom.status, 400);
    assert.match(noRoom.data.error.message, /room_id/);
    const unknown = await json('POST', '/api/open/notifications', { room_id: 'orm_nope', handle: 'jason', url: `${hookBase}/x` });
    assert.equal(unknown.status, 404);
    // A stranger who is not in that room gets nothing: without a guest key it is 401, and with a
    // key of their own (from the lobby) it is not_joined.
    const keyless = await json('POST', '/api/open/notifications', { room_id: secret, handle: 'mallory', url: `${hookBase}/x` });
    assert.equal(keyless.status, 401);
    assert.equal(keyless.data.error.code, 'guest_key_required');
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'mallory', party: 'human' });
    const stranger = await json('POST', '/api/open/notifications', { room_id: secret, handle: 'mallory', url: `${hookBase}/x` });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.data.error.code, 'not_joined');
    // Naming jason with mallory's key is refused the same way.
    const posing = await json('POST', '/api/open/notifications', { room_id: secret, handle: 'jason', url: `${hookBase}/x` }, { 'X-Lyceum-Guest': keyFor('mallory') });
    assert.equal(posing.status, 403);
    assert.equal(posing.data.error.code, 'not_joined');
    const lobbyOnly = await json('POST', '/api/open/notifications', { room_id: 'open-welcome', handle: 'jason', url: `${hookBase}/x` });
    assert.equal(lobbyOnly.status, 403);
    const push = await json('POST', '/api/open/push/subscribe', { handle: 'jason', subscription: device('a') });
    assert.equal(push.status, 400);
    const pushElsewhere = await json('POST', '/api/open/push/subscribe', { room_id: 'open-welcome', handle: 'jason', subscription: device('a') });
    assert.equal(pushElsewhere.status, 403);
    assert.equal(notify._subscriptions.size, 0);
  });

  it('the original leak: subscribing in one room hears nothing from the name\'s other rooms', async () => {
    const secret = await roomWith('Private', 'jason', 'ana');
    // Someone joins the public lobby as "jason" while the real jason is in the unlisted room.
    // (Names are per room, so the lobby lets them take it.)
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    const reg = await json('POST', '/api/open/notifications', {
      room_id: 'open-welcome',
      handle: 'jason',
      url: `${hookBase}/lobby`,
      events: ['message'],
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.room_id, 'open-welcome');
    await json('POST', `/api/open/rooms/${secret}/post`, { handle: 'ana', body: 'private @jason', awaiting: ['jason'] });
    await settle();
    assert.equal(received.length, 0, 'nothing from the unlisted room');
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'bo', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'bo', body: 'lobby news' });
    await waitFor(() => received.length === 1);
    assert.equal(received[0].body.room.id, 'open-welcome');
  });

  it('leaving the room drops its subscriptions (webhook and push); timing out does not', async () => {
    const room = await roomWith('R', 'jason', 'ana');
    const hook = await json('POST', '/api/open/notifications', { room_id: room, handle: 'jason', url: `${hookBase}/j`, events: ['message'] });
    const push = await json('POST', '/api/open/push/subscribe', { room_id: room, handle: 'jason', subscription: device('j'), events: ['message'] });
    const other = await roomWith('Other', 'jason', 'ana');
    await json('POST', '/api/open/notifications', { room_id: other, handle: 'jason', url: `${hookBase}/other`, events: ['message'] });
    assert.equal(hook.status, 201);
    assert.equal(push.status, 201);
    assert.equal(notify.list('human', 'jason').length, 3);

    await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'jason' });
    assert.deepEqual(notify.list('human', 'jason').map((s) => s.room_id), [other]);
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'ana', body: 'after leave @jason' });
    await settle();
    assert.equal(received.length, 0);
    assert.equal(pushed.length, 0);

    // Rejoining under the same name does not bring old subscriptions back.
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'jason', party: 'human' });
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'ana', body: 'again' });
    await settle();
    assert.equal(received.length, 0);
  });

  it('the same device can have one push subscription per room', async () => {
    const a = await roomWith('A', 'jason');
    const b = await roomWith('B', 'jason');
    await json('POST', '/api/open/push/subscribe', { room_id: a, handle: 'jason', subscription: device('d') });
    await json('POST', '/api/open/push/subscribe', { room_id: b, handle: 'jason', subscription: device('d') });
    await json('POST', '/api/open/push/subscribe', { room_id: b, handle: 'jason', subscription: device('d') });
    assert.deepEqual(notify.list('human', 'jason').map((s) => s.room_id).sort(), [a, b].sort());
  });

  it('an AI Bearer subscribes only for its own room', async () => {
    const room = (await json('POST', '/api/open/rooms', { title: 'AI' })).data.room_id;
    const join = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'bot-1', party: 'ai' });
    const auth = { Authorization: `Bearer ${join.data.credential}` };
    const wrong = await json('POST', '/api/open/notifications', { room_id: 'open-welcome', url: `${hookBase}/b` }, auth);
    assert.equal(wrong.status, 400);
    const ok = await json('POST', '/api/open/notifications', { url: `${hookBase}/b` }, auth);
    assert.equal(ok.status, 201);
    assert.equal(ok.data.room_id, room);
    await json('POST', `/api/open/rooms/${room}/leave`, {}, auth);
    assert.equal(notify.list('ai', 'bot-1').length, 0);
  });

  it('MCP subscribe needs a room, joins it, and is scoped to it', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?key=${CLAUDE_KEY}`)));
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
    };
    const missing = await call('subscribe_notifications', { url: `${hookBase}/c` });
    assert.equal(missing.isError, true);
    const nope = await call('subscribe_notifications', { room_id: 'orm_nope', url: `${hookBase}/c` });
    assert.equal(nope.isError, true);
    const room = await roomWith('M', 'jason');
    const ok = await call('subscribe_notifications', { room_id: room, url: `${hookBase}/c` });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(openStore.hasAi(openStore.getRoom(room), 'claude-test'), true);
    assert.match((await call('list_notifications', {})).text, new RegExp(`room ${room}`));
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'lobby', awaiting: ['claude-test'] });
    await settle();
    assert.equal(received.length, 0);
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'jason', body: 'here', awaiting: ['claude-test'] });
    await waitFor(() => received.length === 1);
    assert.equal(received[0].body.room.id, room);
    await client.close();
  });

  it('subscriptions from before the rule (no room) are dropped on restore and never delivered', async () => {
    const room = await roomWith('Old', 'jason', 'ana');
    const legacy = {
      id: 'hook_legacy01',
      secret: 'x'.repeat(48),
      party: 'human',
      who: 'jason',
      url: `${hookBase}/legacy`,
      events: ['turn', 'mention', 'message'],
      created_at: new Date().toISOString(),
      enabled: true,
      failures: 0,
      sent: [],
      last_status: null,
    };
    const snap = JSON.parse(JSON.stringify(persist.serialize()));
    snap.open.webhooks = [legacy];
    persist.restore(snap);
    assert.equal(notify._subscriptions.size, 0);
    // Even if one slips in some other way, dispatch drops it instead of delivering.
    notify._subscriptions.set(legacy.id, { ...legacy });
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'ana', body: '@jason hi' });
    await settle();
    assert.equal(received.length, 0);
    assert.equal(notify._subscriptions.size, 0);
  });
});
