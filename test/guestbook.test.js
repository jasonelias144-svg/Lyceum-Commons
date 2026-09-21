/**
 * Guest book API + page presence tests.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

let app;
let server;
let base;

before(async () => {
  app = require('../src/server');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store.clearAll();
});

async function json(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('Guest book', () => {
  it('lists empty signatures on boot — no fake names', async () => {
    const res = await json('GET', '/api/guestbook');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.signatures));
    assert.equal(res.data.signatures.length, 0);
  });

  it('creates a signature and lists newest first', async () => {
    const first = await json('POST', '/api/guestbook', {
      handle: 'Ada',
      body: 'Arrived.',
    });
    assert.equal(first.status, 201);
    assert.equal(first.data.signature.handle, 'Ada');
    assert.equal(first.data.signature.body, 'Arrived.');
    assert.ok(first.data.signature.id);
    assert.ok(first.data.signature.created_at);

    // slight delay not required; insertion order guarantees newest first
    const second = await json('POST', '/api/guestbook', {
      handle: 'Bea',
      body: 'Hello floor.',
    });
    assert.equal(second.status, 201);

    const list = await json('GET', '/api/guestbook');
    assert.equal(list.status, 200);
    assert.equal(list.data.signatures.length, 2);
    assert.equal(list.data.signatures[0].handle, 'Bea');
    assert.equal(list.data.signatures[0].body, 'Hello floor.');
    assert.equal(list.data.signatures[1].handle, 'Ada');
  });

  it('refuses empty, over-cap, and invalid handle', async () => {
    const empty = await json('POST', '/api/guestbook', { handle: 'Ada', body: '' });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error.code, 'invalid_signature');

    const over = await json('POST', '/api/guestbook', {
      handle: 'Ada',
      body: 'x'.repeat(51),
    });
    assert.equal(over.status, 400);
    assert.equal(over.data.error.code, 'invalid_signature');

    const badHandle = await json('POST', '/api/guestbook', { handle: '', body: 'Hi' });
    assert.equal(badHandle.status, 400);
    assert.equal(badHandle.data.error.code, 'invalid_handle');
  });

  it('accepts exactly 50 characters', async () => {
    const body = 'y'.repeat(50);
    const res = await json('POST', '/api/guestbook', { handle: 'Cap', body });
    assert.equal(res.status, 201);
    assert.equal(res.data.signature.body.length, 50);
  });

  it('soft-refuses bare URLs', async () => {
    const http = await json('POST', '/api/guestbook', {
      handle: 'Ada',
      body: 'https://example.com',
    });
    assert.equal(http.status, 400);
    assert.equal(http.data.error.code, 'bare_url');

    const www = await json('POST', '/api/guestbook', {
      handle: 'Ada',
      body: 'www.example.com',
    });
    assert.equal(www.status, 400);
    assert.equal(www.data.error.code, 'bare_url');
  });

  it('refuses AI/machine party when party field present', async () => {
    const ai = await json('POST', '/api/guestbook', {
      handle: 'Bot',
      body: 'beep',
      party: 'ai',
    });
    assert.equal(ai.status, 403);
    assert.equal(ai.data.error.code, 'not_human');

    const machine = await json('POST', '/api/guestbook', {
      handle: 'Bot',
      body: 'beep',
      party: 'machine',
    });
    assert.equal(machine.status, 403);
    assert.equal(machine.data.error.code, 'not_human');
  });

  it('is separate from Human room messages', async () => {
    await json('POST', '/api/guestbook', { handle: 'Ada', body: 'Wall only.' });
    const join = await json('POST', '/api/human/rooms/welcome/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(join.status, 200);
    const msgs = await json('GET', '/api/human/rooms/welcome/messages');
    assert.equal(msgs.data.messages.length, 0);
    const gb = await json('GET', '/api/guestbook');
    assert.equal(gb.data.signatures.length, 1);
  });

  it('home and /human show guest book empty state and CTA', async () => {
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /guest book/i);
    assert.match(home, /Sign the guest book/);
    assert.match(home, /Be the first to sign/);
    assert.match(home, /id="guestbook-form"/);

    const human = await (await fetch(`${base}/human`)).text();
    assert.match(human, /guest book/i);
    assert.match(human, /Sign the guest book/);
    assert.match(human, /Be the first to sign/);
    assert.match(human, /id="guestbook-form"/);
  });
});
