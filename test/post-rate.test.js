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
      const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
      const bot = (await json('POST', `/api/open/rooms/${a}/join`, { agent_id: 'fresh-bot', party: 'ai' })).data;
      const auth = { Authorization: `Bearer ${bot.credential}` };
      for (let i = 0; i < 5; i++) {
        assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { body: `m${i}` }, auth)).status, 201);
      }
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { body: 'm5' }, auth)).status, 429);
    });

    it('MCP connectors (configured by the operator) start at the full rate', () => {
      for (let i = 0; i < 30; i++) assert.equal(rateLimit.takePost('mcp:bot'), 0);
      assert.ok(rateLimit.takePost('mcp:bot') > 0);
    });
  });

  it('/api/human posts are limited per guest key (live/board rate)', async () => {
    const room = (await json('POST', '/api/human/rooms', {})).data.room_id; // board
    await json('POST', `/api/human/rooms/${room}/join`, { handle: 'h1', party: 'human' });
    await json('POST', `/api/human/rooms/${room}/join`, { handle: 'h2', party: 'human' });
    const post = (handle, body) =>
      json('POST', `/api/human/rooms/${room}/post`, { handle, body, party: 'human' });
    assert.equal((await post('h1', 'one')).status, 201);
    assert.equal((await post('h1', 'two')).status, 201);
    const res = await post('h1', 'three');
    assert.equal(res.status, 429, 'a third post under the same key');
    assert.equal(res.data.error.code, 'rate_limited');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    // A different key from the same address still has its own allowance (until the IP ceiling).
    assert.equal((await post('h2', 'other-one')).status, 201);
    assert.equal((await post('h2', 'other-two')).status, 201);
    process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '0';
    process.env.HUMAN_POST_IP_RATE_PER_MIN = '0';
    try {
      assert.equal((await post('h1', 'four')).status, 201, 'board+IP knobs at 0 turn the keyed limit off');
    } finally {
      process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '2';
      process.env.HUMAN_POST_IP_RATE_PER_MIN = '5';
    }
  });

  it('/api/human live posts use HUMAN_LIVE_POST_RATE_PER_MIN (default 45)', async () => {
    assert.equal(rateLimit.DEFAULT_HUMAN_LIVE_PER_MIN, 45);
    process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '2';
    await json('POST', '/api/human/rooms/welcome/join', { handle: 'live1', party: 'human' });
    const post = (body) =>
      json('POST', '/api/human/rooms/welcome/post', { handle: 'live1', body, party: 'human' });
    assert.equal((await post('one')).status, 201);
    assert.equal((await post('two')).status, 201);
    assert.equal((await post('three')).status, 429);
  });

  it('takeHumanPost without a key still falls back to the address-only bucket', () => {
    rateLimit._reset();
    const ip = 'ip:203.0.113.9';
    assert.equal(rateLimit.takeHumanPost(ip), 0);
    assert.equal(rateLimit.takeHumanPost(ip), 0);
    assert.ok(rateLimit.takeHumanPost(ip) > 0, 'third address-only post waits');
    // A keyed call from another address does not spend the address-only bucket above.
    assert.equal(rateLimit.takeHumanPost('ip:203.0.113.10', 'human:guest:gst_a', { format: 'board' }), 0);
    process.env.HUMAN_POST_RATE_PER_MIN = '0';
    try {
      rateLimit._reset();
      assert.equal(rateLimit.takeHumanPost(ip), 0, 'HUMAN_POST_RATE_PER_MIN=0 turns address-only off');
      assert.equal(rateLimit.takeHumanPost(ip), 0);
    } finally {
      process.env.HUMAN_POST_RATE_PER_MIN = '2';
    }
  });

  it('board and live allowances do not leak through a shared per-key bucket (B-1)', async () => {
    process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '45';
    process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '20';
    process.env.HUMAN_POST_IP_RATE_PER_MIN = '200';
    // Burst above board so a freshly minted key is not stuck on the new-key ramp for this check.
    process.env.OPEN_POST_NEW_KEY_BURST = '45';
    process.env.HUMAN_POST_NEW_KEY_BURST = '45';
    try {
      const board = (await json('POST', '/api/human/rooms', {})).data.room_id;
      await json('POST', `/api/human/rooms/${board}/join`, { handle: 'alt', party: 'human' });
      await json('POST', '/api/human/rooms/welcome/join', { handle: 'alt', party: 'human' });
      // Spend the whole board allowance.
      for (let i = 0; i < 20; i++) {
        assert.equal(
          (await json('POST', `/api/human/rooms/${board}/post`, { handle: 'alt', body: `b${i}`, party: 'human' })).status,
          201,
          `board post ${i}`
        );
      }
      assert.equal(
        (await json('POST', `/api/human/rooms/${board}/post`, { handle: 'alt', body: 'b21', party: 'human' })).status,
        429,
        "board's 21st post in a minute"
      );
      // Live still has its own 45.
      assert.equal(
        (await json('POST', '/api/human/rooms/welcome/post', { handle: 'alt', body: 'live-ok', party: 'human' })).status,
        201,
        'live allowance is independent of board'
      );
    } finally {
      process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '2';
      process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '2';
      process.env.HUMAN_POST_IP_RATE_PER_MIN = '5';
      process.env.OPEN_POST_NEW_KEY_BURST = '5';
      process.env.HUMAN_POST_NEW_KEY_BURST = '8';
    }
  });

  it('HUMAN_LIVE_POST_RATE_PER_MIN defaults to 45 and ignores HUMAN_POST_RATE_PER_MIN', () => {
    rateLimit._reset();
    delete process.env.HUMAN_LIVE_POST_RATE_PER_MIN;
    process.env.HUMAN_POST_RATE_PER_MIN = '30';
    process.env.HUMAN_POST_IP_RATE_PER_MIN = '200';
    try {
      // Direct unit check: live keyed posts use 45, not the address knob 30.
      const ip = 'ip:198.51.100.9';
      const key = 'human:guest:gst_live_default';
      let n = 0;
      while (n < 50 && rateLimit.takeHumanPost(ip, key, { format: 'live' }) === 0) n += 1;
      assert.equal(n, 45);
      assert.ok(rateLimit.takeHumanPost(ip, key, { format: 'live' }) > 0);
    } finally {
      process.env.HUMAN_POST_RATE_PER_MIN = '2';
      process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '2';
      process.env.HUMAN_POST_IP_RATE_PER_MIN = '5';
    }
  });

  it('many Human keys from one address share HUMAN_POST_IP_RATE_PER_MIN', async () => {
    process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '10';
    process.env.HUMAN_POST_IP_RATE_PER_MIN = '3';
    try {
      const room = (await json('POST', '/api/human/rooms', {})).data.room_id;
      for (const h of ['a', 'b', 'c']) {
        await json('POST', `/api/human/rooms/${room}/join`, { handle: h, party: 'human' });
      }
      assert.equal(
        (await json('POST', `/api/human/rooms/${room}/post`, { handle: 'a', body: '1', party: 'human' })).status,
        201
      );
      assert.equal(
        (await json('POST', `/api/human/rooms/${room}/post`, { handle: 'b', body: '2', party: 'human' })).status,
        201
      );
      assert.equal(
        (await json('POST', `/api/human/rooms/${room}/post`, { handle: 'c', body: '3', party: 'human' })).status,
        201
      );
      const res = await json('POST', `/api/human/rooms/${room}/post`, {
        handle: 'a',
        body: '4',
        party: 'human',
      });
      assert.equal(res.status, 429, 'fourth post from the address, under any key');
    } finally {
      process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '2';
      process.env.HUMAN_POST_IP_RATE_PER_MIN = '5';
    }
  });

  it('Human and Open posts from one address use separate allowances', async () => {
    const room = (await json('POST', '/api/human/rooms', {})).data.room_id;
    await json('POST', `/api/human/rooms/${room}/join`, { handle: 'h1', party: 'human' });
    const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
    await json('POST', `/api/open/rooms/${a}/join`, { handle: 'p', party: 'human' });
    for (let i = 0; i < 3; i++) {
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: `m${i}` })).status, 201);
    }
    assert.equal((await json('POST', `/api/human/rooms/${room}/post`, { handle: 'h1', body: 'h', party: 'human' })).status, 201);
  });

  describe('client address behind Railway (live QC on 3acf30f)', () => {
    const header = process.env.OPEN_CLIENT_IP_HEADER;
    beforeEach(() => {
      process.env.OPEN_CLIENT_IP_HEADER = 'x-real-ip';
    });
    after(() => {
      if (header === undefined) delete process.env.OPEN_CLIENT_IP_HEADER;
      else process.env.OPEN_CLIENT_IP_HEADER = header;
    });

    async function room() {
      const a = (await json('POST', '/api/open/rooms', { title: 'a' })).data.room_id;
      await json('POST', `/api/open/rooms/${a}/join`, { handle: 'p', party: 'human' });
      return a;
    }

    it('keys on X-Real-IP even when the internal hop in X-Forwarded-For changes every request', async () => {
      const a = await room();
      await json('POST', `/api/open/rooms/${a}/join`, { handle: 'r', party: 'human' });
      const post = (who, i, ip) =>
        json('POST', `/api/open/rooms/${a}/post`, { handle: who, body: `m${i}` }, {
          'X-Real-IP': ip,
          'X-Forwarded-For': `${ip}, 100.64.${i}.${i + 1}`,
        });
      for (let i = 0; i < 3; i++) assert.equal((await post('p', i, '203.0.113.7')).status, 201);
      assert.equal((await post('p', 3, '203.0.113.7')).status, 429, 'p is out');
      assert.equal((await post('r', 4, '203.0.113.7')).status, 201);
      assert.equal((await post('r', 5, '203.0.113.7')).status, 201);
      const res = await post('r', 6, '203.0.113.7');
      assert.equal(res.status, 429, 'the address ceiling (5) holds across hops');
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal((await post('r', 7, '198.51.100.9')).status, 201, 'another address has its own ceiling');
    });

    const fakeReq = (headers, ip) => ({ ip, get: (n) => headers[n.toLowerCase()] });

    it('without a usable X-Real-IP, every request shares one fallback bucket (req.ip changes per hop there)', async () => {
      const k1 = rateLimit.clientKey(fakeReq({}, '100.64.0.1'));
      const k2 = rateLimit.clientKey(fakeReq({}, '100.64.0.2'));
      const k3 = rateLimit.clientKey(fakeReq({ 'x-real-ip': 'not-an-ip' }, '100.64.0.3'));
      const k4 = rateLimit.clientKey(fakeReq({ 'x-real-ip': '1.2.3.4.5' }, '100.64.0.4'));
      for (const k of [k1, k2, k3, k4]) assert.equal(k, rateLimit.FALLBACK_KEY);
      // Over HTTP: posts with no header at all run out together.
      const a = await room();
      for (let i = 0; i < 3; i++) {
        assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: `m${i}` })).status, 201);
      }
      await json('POST', `/api/open/rooms/${a}/join`, { handle: 'r', party: 'human' });
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'r', body: 'x' }, { 'X-Real-IP': 'junk' })).status, 429, 'the fallback bucket is held to the per-key rate (3)');
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'r', body: 'y' }, { 'X-Real-IP': '203.0.113.7' })).status, 201, 'a real address keeps its own allowance');
    });

    it('groups IPv6 by /64 and reads an IPv4-mapped address as IPv4', () => {
      const k = (ip) => rateLimit.clientKey(fakeReq({ 'x-real-ip': ip }, '100.64.0.1'));
      assert.equal(k('2001:db8:1:2:aaaa::1'), k('2001:0db8:0001:0002:ffff:1:2:3'));
      assert.notEqual(k('2001:db8:1:2::1'), k('2001:db8:1:3::1'));
      assert.equal(k('::ffff:203.0.113.7'), k('203.0.113.7'));
      assert.equal(k('203.0.113.7, 10.0.0.1'), 'ip:203.0.113.7');
    });

    it('maps every spelling of an IPv4-mapped address to its IPv4 (L-1)', () => {
      for (const ip of ['::ffff:203.0.113.7', '0:0:0:0:0:ffff:203.0.113.7', '::ffff:cb00:7107', '::FFFF:CB00:7107', '0:0:0:0:0:ffff:cb00:7107']) {
        assert.equal(rateLimit.addressKey(ip), '203.0.113.7', ip);
      }
      assert.equal(rateLimit.addressKey('::1'), '0:0:0:0::/64');
      assert.equal(rateLimit.addressKey('::ffff:0:cb00:7107'), '0:0:0:0::/64', 'SIIT form is not ::ffff:0:0/96');
    });

    it('warns loudly, once, when OPEN_CLIENT_IP_HEADER is not a known proxy header (L-2)', () => {
      const lines = [];
      const warn = console.warn;
      console.warn = (m) => lines.push(String(m));
      try {
        process.env.OPEN_CLIENT_IP_HEADER = 'x-real-ipp';
        for (let i = 0; i < 3; i++) assert.equal(rateLimit.clientKey(fakeReq({}, '100.64.0.1')), rateLimit.FALLBACK_KEY);
        process.env.OPEN_CLIENT_IP_HEADER = 'CF-Connecting-IP';
        rateLimit.clientKey(fakeReq({ 'cf-connecting-ip': '203.0.113.7' }, '100.64.0.1'));
      } finally {
        console.warn = warn;
        process.env.OPEN_CLIENT_IP_HEADER = 'x-real-ip';
      }
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /^WARNING: OPEN_CLIENT_IP_HEADER is "x-real-ipp"/);
      assert.match(lines[0], /ONE rate-limit allowance/);
    });

    it('treats a whitespace-only OPEN_CLIENT_IP_HEADER as unset with a warning, and warns that x-forwarded-for can be faked (L-3)', () => {
      const lines = [];
      const warn = console.warn;
      const railway = process.env.RAILWAY_ENVIRONMENT;
      console.warn = (m) => lines.push(String(m));
      try {
        process.env.RAILWAY_ENVIRONMENT = 'production';
        process.env.OPEN_CLIENT_IP_HEADER = '   ';
        assert.equal(rateLimit.clientIpHeader(), 'x-real-ip');
        assert.equal(rateLimit.clientIpHeader(), 'x-real-ip');
        assert.equal(lines.length, 1, lines.join('\n'));
        assert.match(lines[0], /is set but blank, so it counts as unset/);
        process.env.OPEN_CLIENT_IP_HEADER = 'X-Forwarded-For';
        assert.equal(rateLimit.clientIpHeader(), 'x-forwarded-for');
        assert.equal(lines.length, 2);
        assert.match(lines[1], /"x-forwarded-for"\. Behind most proxies/);
      } finally {
        console.warn = warn;
        if (railway === undefined) delete process.env.RAILWAY_ENVIRONMENT;
        else process.env.RAILWAY_ENVIRONMENT = railway;
        process.env.OPEN_CLIENT_IP_HEADER = 'x-real-ip';
      }
    });

    it('logs each keying state once, without addresses', () => {
      const lines = [];
      const log = console.log;
      console.log = (m) => lines.push(String(m));
      try {
        for (let i = 0; i < 3; i++) {
          rateLimit.clientKey(fakeReq({ 'x-real-ip': '203.0.113.7' }, '100.64.0.1'));
          rateLimit.clientKey(fakeReq({}, '100.64.0.1'));
          rateLimit.clientKey(fakeReq({ 'x-real-ip': 'junk' }, '100.64.0.1'));
        }
      } finally {
        console.log = log;
      }
      assert.equal(lines.length, 3);
      assert.ok(lines.every((l) => !/\d+\.\d+\.\d+\.\d+/.test(l)), lines.join('\n'));
    });

    it('with no header configured, keys on req.ip (normalized), falling back when it is not an address', () => {
      process.env.OPEN_CLIENT_IP_HEADER = 'none';
      assert.equal(rateLimit.clientKey(fakeReq({ 'x-real-ip': '203.0.113.7' }, '::ffff:127.0.0.1')), 'ip:127.0.0.1');
      assert.equal(rateLimit.clientKey(fakeReq({}, undefined)), rateLimit.FALLBACK_KEY);
    });

    it('defaults to X-Real-IP only on Railway, and OPEN_CLIENT_IP_HEADER=none turns it off', () => {
      const railway = process.env.RAILWAY_ENVIRONMENT;
      try {
        delete process.env.OPEN_CLIENT_IP_HEADER;
        delete process.env.RAILWAY_ENVIRONMENT;
        assert.equal(rateLimit.clientIpHeader(), null);
        process.env.RAILWAY_ENVIRONMENT = 'production';
        assert.equal(rateLimit.clientIpHeader(), 'x-real-ip');
        process.env.OPEN_CLIENT_IP_HEADER = 'none';
        assert.equal(rateLimit.clientIpHeader(), null);
        process.env.OPEN_CLIENT_IP_HEADER = 'CF-Connecting-IP';
        assert.equal(rateLimit.clientIpHeader(), 'cf-connecting-ip');
      } finally {
        if (railway === undefined) delete process.env.RAILWAY_ENVIRONMENT;
        else process.env.RAILWAY_ENVIRONMENT = railway;
      }
    });
  });

  describe('knobs and cost (QC Handoff 19)', () => {
    const KNOBS = [
      'OPEN_POST_NEW_KEY_BURST',
      'OPEN_POST_RATE_PER_MIN',
      'OPEN_POST_NEW_KEY_RAMP_MS',
      'OPEN_POST_IP_RATE_PER_MIN',
      'HUMAN_POST_RATE_PER_MIN',
      'HUMAN_LIVE_POST_RATE_PER_MIN',
      'HUMAN_BOARD_POST_RATE_PER_MIN',
      'HUMAN_POST_IP_RATE_PER_MIN',
      'HUMAN_POST_ROOM_RATE_PER_MIN',
      'HUMAN_POST_NEW_KEY_BURST',
      'HUMAN_POST_NEW_KEY_RAMP_MS',
      'HUMAN_JOIN_RATE_PER_MIN',
      'HUMAN_REJOIN_RATE_PER_MIN',
      'HUMAN_GUESTBOOK_RATE_PER_MIN',
      'HUMAN_STRUCT_RATE_PER_MIN',
      'JOIN_SITE_RATE_PER_MIN',
    ];
    let saved;
    let warn;
    let warnings;
    beforeEach(() => {
      saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
      warnings = [];
      warn = console.warn;
      console.warn = (m) => warnings.push(String(m));
    });
    const restore = () => {
      console.warn = warn;
      for (const k of KNOBS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rateLimit._reset();
    };

    it('a burst of 0 or a fraction falls back to the default with one warning, never an endless wait', () => {
      try {
        for (const bad of ['0', '0.5', '-1', 'five']) {
          rateLimit._reset();
          warnings.length = 0;
          process.env.OPEN_POST_RATE_PER_MIN = '30';
          process.env.OPEN_POST_NEW_KEY_BURST = bad;
          rateLimit.markNew('k');
          for (let i = 0; i < 5; i++) assert.equal(rateLimit.takeOpenPost('1.2.3.4', 'k'), 0, `${bad}: post ${i + 1}`);
          const wait = rateLimit.takeOpenPost('1.2.3.4', 'k');
          assert.ok(wait > 0 && wait <= 60000, `${bad}: wait ${wait}`);
          assert.equal(warnings.filter((w) => w.includes('OPEN_POST_NEW_KEY_BURST')).length, 1, bad);
        }
      } finally {
        restore();
      }
    });

    it('a fractional rate is not accepted (it could never refill a whole post)', () => {
      try {
        rateLimit._reset();
        process.env.OPEN_POST_RATE_PER_MIN = '0.5';
        assert.equal(rateLimit.takePost('mcp:x'), 0);
        assert.equal(warnings.filter((w) => w.includes('OPEN_POST_RATE_PER_MIN')).length, 1);
      } finally {
        restore();
      }
    });

    it('checkKnobs warns once at boot for a bad knob; a later read does not warn again', () => {
      try {
        rateLimit._reset();
        process.env.OPEN_POST_RATE_PER_MIN = 'nope';
        warnings.length = 0;
        rateLimit.checkKnobs();
        assert.equal(warnings.filter((w) => w.includes('OPEN_POST_RATE_PER_MIN')).length, 1);
        // A later post that reads the same knob must not warn again.
        assert.equal(rateLimit.takePost('mcp:x'), 0);
        assert.equal(warnings.filter((w) => w.includes('OPEN_POST_RATE_PER_MIN')).length, 1);
      } finally {
        restore();
      }
    });

    it('checkKnobs does not warn for valid or unset knobs', () => {
      try {
        rateLimit._reset();
        delete process.env.OPEN_POST_RATE_PER_MIN;
        delete process.env.OPEN_POST_IP_RATE_PER_MIN;
        delete process.env.OPEN_POST_NEW_KEY_BURST;
        delete process.env.OPEN_POST_NEW_KEY_RAMP_MS;
        delete process.env.HUMAN_POST_RATE_PER_MIN;
        delete process.env.HUMAN_LIVE_POST_RATE_PER_MIN;
        delete process.env.HUMAN_BOARD_POST_RATE_PER_MIN;
        delete process.env.HUMAN_POST_IP_RATE_PER_MIN;
        process.env.OPEN_POST_IP_RATE_PER_MIN = '120';
        warnings.length = 0;
        rateLimit.checkKnobs();
        assert.equal(warnings.length, 0);
      } finally {
        restore();
      }
    });

    it('a flood of new keys mid-ramp stays cheap (no scan per join) and refused posts leave no bucket', () => {
      try {
        rateLimit._reset();
        process.env.OPEN_POST_RATE_PER_MIN = '30';
        const start = process.hrtime.bigint();
        for (let i = 0; i < 30000; i++) {
          rateLimit.markNew(`g${i}`);
          rateLimit.takeOpenPost('9.9.9.9', `g${i}`);
        }
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        assert.ok(ms < 3000, `30k joins took ${ms} ms`);
        // 120 got through on the address ceiling; every refused key left no bucket behind.
        assert.ok(rateLimit._sizes().buckets <= 121, `buckets ${rateLimit._sizes().buckets}`);
        for (let i = 30000; i < 60000; i++) rateLimit.markNew(`g${i}`);
        assert.equal(rateLimit._sizes().born, 50000);
      } finally {
        restore();
      }
    });
  });

});
