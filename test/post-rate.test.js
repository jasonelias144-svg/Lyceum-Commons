/**
 * Post rate limit (R12-1b): each client address gets OPEN_POST_RATE_PER_MIN posts a minute, then 429.
 */
process.env.OPEN_POST_RATE_PER_MIN = '3';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const openStore = require('../src/openStore');
const rateLimit = require('../src/rateLimit');

let server;
let base;

before(async () => {
  const app = require('../src/server');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  openStore.clearAll();
  rateLimit._reset();
});

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

describe('Post rate limit (R12-1b)', () => {
  it('refuses the fourth post in a minute with 429 and Retry-After, across names and rooms', async () => {
    const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
    const b = (await json('POST', '/api/open/rooms', { title: 'b' })).data.room_id;
    await json('POST', `/api/open/rooms/${a}/join`, { handle: 'p', party: 'human' });
    const bot = (await json('POST', `/api/open/rooms/${b}/join`, { agent_id: 'q-bot', party: 'ai' })).data;
    assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: 'one' })).status, 201);
    assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: 'two' })).status, 201);
    const auth = { Authorization: `Bearer ${bot.credential}` };
    assert.equal((await json('POST', `/api/open/rooms/${b}/post`, { body: 'three' }, auth)).status, 201);
    const res = await json('POST', `/api/open/rooms/${b}/post`, { body: 'four' }, auth);
    assert.equal(res.status, 429);
    assert.equal(res.data.error.code, 'rate_limited');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.equal(openStore.getRoom(b).messages.length, 1);
  });

  it('a refused or invalid post does not use up the allowance', async () => {
    const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
    await json('POST', `/api/open/rooms/${a}/join`, { handle: 'p', party: 'human' });
    for (let i = 0; i < 5; i++) {
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'nobody', body: 'x' })).status, 403);
    }
    for (let i = 0; i < 3; i++) {
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: `m${i}` })).status, 201);
    }
  });

  it('refills over the minute, per key', () => {
    let t = 1_000_000;
    rateLimit._setClock(() => t);
    for (let i = 0; i < 3; i++) assert.equal(rateLimit.takePost('k'), 0);
    const wait = rateLimit.takePost('k');
    assert.ok(wait > 0 && wait <= 20000, `wait ${wait}`);
    assert.equal(rateLimit.takePost('other'), 0);
    t += 20000;
    assert.equal(rateLimit.takePost('k'), 0);
    assert.ok(rateLimit.takePost('k') > 0);
  });

  it('OPEN_POST_RATE_PER_MIN=0 turns it off', () => {
    process.env.OPEN_POST_RATE_PER_MIN = '0';
    try {
      for (let i = 0; i < 100; i++) assert.equal(rateLimit.takePost('k'), 0);
    } finally {
      process.env.OPEN_POST_RATE_PER_MIN = '3';
    }
  });
});
