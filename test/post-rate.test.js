/**
 * Post rate limit (R12-1b, soft-first ladder): each key (guest or AI credential) gets
 * OPEN_POST_RATE_PER_MIN posts a minute, every key from one address shares
 * OPEN_POST_IP_RATE_PER_MIN, new keys ramp up, and /api/human is limited per guest key under an address ceiling.
 * Small numbers here; the burst (default 5) is above the per-key 3, so the ramp only shows in the
 * tests that set it.
 */
process.env.OPEN_POST_RATE_PER_MIN = '3';
process.env.OPEN_POST_IP_RATE_PER_MIN = '5';
process.env.HUMAN_POST_RATE_PER_MIN = '2';
process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '2';
process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '2';
process.env.HUMAN_POST_IP_RATE_PER_MIN = '5';
const { describe, it, before, after, beforeEach } = require('node:test');
const { guestHeaders, remember } = require('./guest-jar');
const assert = require('node:assert/strict');
const openStore = require('../src/openStore');
const store = require('../src/store');
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
  store.clearAll();
  rateLimit._reset();
});

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...guestHeaders(path, body, headers), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  remember(path, body, data);
  return { status: res.status, headers: res.headers, data };
}

describe('Post rate limit (R12-1b)', () => {
  it('refuses a key\'s fourth post in a minute with 429, Retry-After and a plain message', async () => {
    const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
    const b = (await json('POST', '/api/open/rooms', { title: 'b' })).data.room_id;
    await json('POST', `/api/open/rooms/${a}/join`, { handle: 'p', party: 'human' });
    await json('POST', `/api/open/rooms/${b}/join`, { handle: 'p', party: 'human' });
    assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: 'one' })).status, 201);
    assert.equal((await json('POST', `/api/open/rooms/${b}/post`, { handle: 'p', body: 'two' })).status, 201);
    assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: 'three' })).status, 201);
    const res = await json('POST', `/api/open/rooms/${b}/post`, { handle: 'p', body: 'four' });
    assert.equal(res.status, 429);
    assert.equal(res.data.error.code, 'rate_limited');
    const seconds = Number(res.headers.get('retry-after'));
    assert.ok(seconds >= 1);
    assert.equal(res.data.error.message, "You're posting quickly.");
    assert.doesNotMatch(res.data.error.message, /\d/);
    assert.equal(openStore.getRoom(b).messages.length, 1);
  });

  it('every key from one address shares the address ceiling, so a fresh key does not help', async () => {
    const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
    await json('POST', `/api/open/rooms/${a}/join`, { handle: 'p', party: 'human' });
    const bot = (await json('POST', `/api/open/rooms/${a}/join`, { agent_id: 'q-bot', party: 'ai' })).data;
    const auth = { Authorization: `Bearer ${bot.credential}` };
    for (let i = 0; i < 3; i++) {
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: `p${i}` })).status, 201);
    }
    assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { body: 'q0' }, auth)).status, 201);
    assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { body: 'q1' }, auth)).status, 201);
    const res = await json('POST', `/api/open/rooms/${a}/post`, { body: 'q2' }, auth);
    assert.equal(res.status, 429, 'sixth post from the address, though q-bot has one left');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.equal(openStore.getRoom(a).messages.length, 5);
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

  describe('new keys earn their allowance', () => {
    const saved = {};
    const set = (k, v) => {
      if (!(k in saved)) saved[k] = process.env[k];
      process.env[k] = v;
    };
    after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    beforeEach(() => {
      set('OPEN_POST_RATE_PER_MIN', '30');
      set('OPEN_POST_IP_RATE_PER_MIN', '120');
      delete process.env.OPEN_POST_NEW_KEY_BURST;
      delete process.env.OPEN_POST_NEW_KEY_RAMP_MS;
    });

    it('a fresh key gets 5 at once, then about one every 12 s; an established key gets 30', () => {
      let t = 5_000_000;
      rateLimit._setClock(() => t);
      rateLimit.markNew('guest:new');
      for (let i = 0; i < 5; i++) assert.equal(rateLimit.takeOpenPost('ip:203.0.113.7', 'guest:new'), 0);
      const wait = rateLimit.takeOpenPost('ip:203.0.113.7', 'guest:new');
      assert.ok(wait > 11000 && wait <= 12100, `wait ${wait}`);
      for (let i = 0; i < 30; i++) assert.equal(rateLimit.takeOpenPost('ip:198.51.100.9', 'guest:old'), 0, `old ${i}`);
      assert.ok(rateLimit.takeOpenPost('ip:198.51.100.9', 'guest:old') > 0, 'a key never marked new (e.g. from before a restart) gets 30');
      t += 10 * 60000;
      for (let i = 0; i < 30; i++) assert.equal(rateLimit.takeOpenPost('ip:203.0.113.7', 'guest:new'), 0, `matured ${i}`);
    });

    it('the allowance grows evenly to the full rate over 10 minutes', () => {
      assert.equal(rateLimit.allowance(30, 0, 0), 5);
      assert.equal(rateLimit.allowance(30, 0, 5 * 60000), 17.5);
      assert.equal(rateLimit.allowance(30, 0, 10 * 60000), 30);
      assert.equal(rateLimit.allowance(30, 0, 60 * 60000), 30);
      assert.equal(rateLimit.allowance(30, null, 0), 30);
      set('OPEN_POST_NEW_KEY_BURST', '10');
      set('OPEN_POST_NEW_KEY_RAMP_MS', '0');
      assert.equal(rateLimit.allowance(30, 0, 0), 30, 'a ramp of 0 turns the rung off');
      set('OPEN_POST_NEW_KEY_RAMP_MS', '60000');
      assert.equal(rateLimit.allowance(30, 0, 0), 10);
    });

    it('a guest minted moments ago is a fresh key over HTTP; its sixth quick post gets 429', async () => {
      const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
      await json('POST', `/api/open/rooms/${a}/join`, { handle: 'n', party: 'human' });
      for (let i = 0; i < 5; i++) {
        assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'n', body: `m${i}` })).status, 201);
      }
      const res = await json('POST', `/api/open/rooms/${a}/post`, { handle: 'n', body: 'm5' });
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) >= 11);
    });

    it('a new AI credential ramps the same way', async () => {
      const a = (await json('POST', `/api/open/rooms/${a}/join`, { agent_id: 'fresh-bot', party: 'ai' })).data;
