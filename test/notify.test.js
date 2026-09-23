/**
 * Notifications — webhooks (turn / mention / message, HMAC-signed, private hosts refused)
 * and operator wake hooks (a routine's /fire endpoint, spaced by WAKE_INTERVAL_MS).
 * A local HTTP server stands in for the receiving end; LYCEUM_WEBHOOK_ALLOW_PRIVATE lets
 * the tests deliver to it.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const openStore = require('../src/openStore');
const notify = require('../src/notify');
const persist = require('../src/persist');

const CLAUDE_KEY = 'claude-test-key-0123456789abcdef';

let app;
let server;
let base;
let receiver;
let hookBase;
let received = [];

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

before(async () => {
  process.env.LYCEUM_MCP_KEYS = `claude-test=${CLAUDE_KEY}`;
  process.env.LYCEUM_WEBHOOK_ALLOW_PRIVATE = '1';
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookBase = `http://127.0.0.1:${receiver.address().port}`;
  app = require('../src/server');
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
  delete process.env.LYCEUM_WAKE_HOOKS;
  notify.clearAll();
  await new Promise((r) => server.close(r));
  await new Promise((r) => receiver.close(r));
});

beforeEach(() => {
  openStore.clearAll();
  notify.clearAll();
  received = [];
  delete process.env.LYCEUM_WAKE_HOOKS;
});

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function mcp() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?key=${CLAUDE_KEY}`)));
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
}

describe('webhooks', () => {
  it('an AI webhook gets a signed "turn" delivery when a human hands it the turn', async () => {
    const claude = await mcp();
    const sub = await call(claude, 'subscribe_notifications', { url: `${hookBase}/claude` });
    assert.match(sub.text, /Subscribed hook_\w+ .* for turn, mention/);
    const secret = sub.text.match(/shown once\): (\w+)/)[1];

    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', {
      handle: 'jason',
      body: 'Over to you.',
      awaiting: ['claude-test'],
    });
    await waitFor(() => received.length === 1);
    const hit = received[0];
    assert.equal(hit.path, '/claude');
    assert.equal(hit.headers['x-lyceum-event'], 'turn');
    const expected = crypto.createHmac('sha256', secret).update(hit.body).digest('hex');
    assert.equal(hit.headers['x-lyceum-signature'], `sha256=${expected}`);
    const data = JSON.parse(hit.body);
    assert.equal(data.event, 'turn');
    assert.equal(data.room.id, 'open-welcome');
    assert.equal(data.message.author, 'jason');
    assert.deepEqual(data.turn.awaiting, ['claude-test']);

    // A plain post (no turn, no mention) is not delivered to a turn+mention subscription.
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'Just talking.' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(received.length, 1);

    assert.match((await call(claude, 'list_notifications')).text, /on · last: 200/);
    const id = sub.text.match(/hook_\w+/)[0];
    assert.match((await call(claude, 'unsubscribe_notifications', { id })).text, /Removed/);
    await claude.close();
  });

  it('a human "message" subscription hears every post in rooms they belong to, never their own', async () => {
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'ana', party: 'human' });
    const reg = await json('POST', '/api/open/notifications', {
      handle: 'jason',
      url: `${hookBase}/jason`,
      events: ['message'],
    });
    assert.equal(reg.status, 201);
    assert.ok(reg.data.secret);
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'mine' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'ana', body: 'hello @jason' });
    await waitFor(() => received.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);
    assert.equal(JSON.parse(received[0].body).message.author, 'ana');

    const status = await json('GET', `/api/open/notifications/${reg.data.id}?secret=${reg.data.secret}`);
    assert.equal(status.status, 200);
    assert.match(status.data.last_status, /^200 at /);
    const peek = await json('GET', `/api/open/notifications/${reg.data.id}?secret=wrong`);
    assert.equal(peek.status, 400);
    const wrong = await json('DELETE', `/api/open/notifications/${reg.data.id}`, { secret: 'nope' });
    assert.equal(wrong.status, 400);
    const ok = await json('DELETE', `/api/open/notifications/${reg.data.id}`, { secret: reg.data.secret });
    assert.equal(ok.status, 200);
  });

  it('refuses http, private hosts and unknown events when private delivery is not allowed', async () => {
    process.env.LYCEUM_WEBHOOK_ALLOW_PRIVATE = '0';
    try {
      for (const url of ['http://example.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://10.1.2.3/x']) {
        const r = await json('POST', '/api/open/notifications', { handle: 'jason', url });
        assert.equal(r.status, 400, url);
      }
      const ev = await json('POST', '/api/open/notifications', {
        handle: 'jason',
        url: 'https://example.com/x',
        events: ['everything'],
      });
      assert.equal(ev.status, 400);
    } finally {
      process.env.LYCEUM_WEBHOOK_ALLOW_PRIVATE = '1';
    }
    assert.equal(notify.isPrivateAddress('192.168.1.1'), true);
    assert.equal(notify.isPrivateAddress('::ffff:10.0.0.1'), true);
    assert.equal(notify.isPrivateAddress('93.184.216.34'), false);
    assert.equal(notify.isNtfyHost('ntfy.sh'), true);
    assert.equal(notify.isNtfyHost('ntfy.envs.net'), true);
    assert.equal(notify.isNtfyHost('example.com'), false);
  });

  it('webhooks survive a snapshot round trip', async () => {
    const sub = await notify.subscribe({ party: 'human', who: 'jason', url: `${hookBase}/x` });
    const snap = JSON.parse(JSON.stringify(persist.serialize()));
    notify.clearAll();
    persist.restore(snap);
    assert.deepEqual(notify.list('human', 'jason'), [notify.describe(sub)]);
  });
});

describe('wake hooks', () => {
  it('fires the routine endpoint when the agent is awaited, then waits out the interval', async () => {
    process.env.LYCEUM_WAKE_HOOKS = `claude-test=${hookBase}/fire|routine-token-123`;
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', {
      handle: 'jason',
      body: 'Your turn.',
      awaiting: ['claude-test'],
    });
    await waitFor(() => received.length === 1);
    const hit = received[0];
    assert.equal(hit.path, '/fire');
    assert.equal(hit.headers.authorization, 'Bearer routine-token-123');
    // A non-Anthropic URL gets the plain event, with the token as a Bearer.
    assert.equal(hit.headers['anthropic-beta'], undefined);
    assert.match(JSON.parse(hit.body).text, /your turn in "Open welcome lobby" \(open-welcome\) by jason/);

    // A second call inside the interval is deferred, not sent now.
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'And @claude-test again.' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received.length, 1);
    assert.ok(notify._wakeState.get('claude-test').timer, 'a deferred wake is scheduled');

    // Plain posts never wake anyone.
    notify.clearAll();
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'no one in particular' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(received.length, 1);
  });

  it('parses LYCEUM_WAKE_HOOKS and skips malformed entries', () => {
    const hooks = notify.loadWakeHooks(
      'a=https://x.example/fire|t1, bad, b=not a url|t, c=https://y.example/hook, d=https://api.anthropic.com/v1/claude_code/routines/r/fire'
    );
    // c: a plain webhook needs no token; d: an Anthropic routine without its token is skipped.
    assert.deepEqual(Array.from(hooks.keys()), ['a', 'c']);
    assert.equal(hooks.get('c').token, null);
    assert.equal(hooks.get('c').anthropic, false);
    const claude = notify.loadWakeHooks('z=https://api.anthropic.com/v1/claude_code/routines/r/fire|tok');
    assert.equal(claude.get('z').anthropic, true);
    assert.equal(claude.get('z').token, 'tok');
  });
});

describe('web push', () => {
  const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'BPk3yK0test', auth: 'authsecret' } });

  it('serves a public key, accepts only real push services, and delivers turn notifications', async () => {
    const key = await json('GET', '/api/open/push/key');
    assert.equal(key.status, 200);
    assert.match(key.data.publicKey, /^[A-Za-z0-9_-]{80,}$/);

    const bad = await json('POST', '/api/open/push/subscribe', { handle: 'jason', subscription: sub('https://evil.example/x') });
    assert.equal(bad.status, 400);
    const missing = await json('POST', '/api/open/push/subscribe', { handle: 'jason', subscription: { endpoint: 'https://web.push.apple.com/x' } });
    assert.equal(missing.status, 400);

    const sent = [];
    notify._setWebPushSender(async (push, body, options) => {
      sent.push({ push, body: JSON.parse(body), options });
      return { statusCode: 201 };
    });
    const ok = await json('POST', '/api/open/push/subscribe', { handle: 'jason', subscription: sub('https://web.push.apple.com/QWxpY2U') });
    assert.equal(ok.status, 201);
    assert.ok(ok.data.secret);

    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'ana', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'ana', body: 'Over to you.', awaiting: ['jason'] });
    await waitFor(() => sent.length === 1);
    assert.equal(sent[0].push.endpoint, 'https://web.push.apple.com/QWxpY2U');
    assert.equal(sent[0].body.title, 'Your turn in Open welcome lobby (from ana)');
    assert.equal(sent[0].body.body, 'Over to you.');
    assert.match(sent[0].body.url, /\/open\?room=open-welcome$/);
    assert.equal(sent[0].options.urgency, 'high');
    assert.equal(sent[0].options.vapidDetails.publicKey, key.data.publicKey);

    // Same device subscribing again replaces, not duplicates.
    await json('POST', '/api/open/push/subscribe', { handle: 'jason', subscription: sub('https://web.push.apple.com/QWxpY2U') });
    assert.equal(notify.list('human', 'jason').length, 1);
  });

  it('drops a subscription the push service reports as gone (410)', async () => {
    notify._setWebPushSender(async () => {
      const err = new Error('gone');
      err.statusCode = 410;
      throw err;
    });
    await json('POST', '/api/open/push/subscribe', { handle: 'jason', subscription: sub('https://fcm.googleapis.com/fcm/send/abc') });
    assert.equal(notify.list('human', 'jason').length, 1);
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'ana', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'ana', body: 'hi @jason' });
    await waitFor(() => notify.list('human', 'jason').length === 0);
  });
});

describe('wake hooks for other apps', () => {
  it('sends a plain JSON event to a non-Anthropic webhook (e.g. a Grok automation)', async () => {
    process.env.LYCEUM_WAKE_HOOKS = `grok-test=${hookBase}/grok-automation`;
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'Grok, your view?', awaiting: ['grok-test'] });
    await waitFor(() => received.length === 1);
    const hit = received[0];
    assert.equal(hit.path, '/grok-automation');
    assert.equal(hit.headers.authorization, undefined);
    assert.equal(hit.headers['anthropic-beta'], undefined);
    const data = JSON.parse(hit.body);
    assert.equal(data.source, 'lyceum-commons');
    assert.equal(data.agent, 'grok-test');
    assert.match(data.text, /your turn in "Open welcome lobby"/);
  });
});
