/**
 * Post rate limit (R12-1b): each client address gets OPEN_POST_RATE_PER_MIN posts a minute, then 429.
 */
process.env.OPEN_POST_RATE_PER_MIN = '3';
const { describe, it, before, after, beforeEach } = require('node:test');
const { guestHeaders, remember } = require('./guest-jar');
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
    headers: { 'Content-Type': 'application/json', ...guestHeaders(path, body, headers), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  remember(path, body, data);
  return { status: res.status, headers: res.headers, data };
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
      const post = (i, ip) =>
        json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: `m${i}` }, {
          'X-Real-IP': ip,
          'X-Forwarded-For': `${ip}, 100.64.${i}.${i + 1}`,
        });
      for (let i = 0; i < 3; i++) assert.equal((await post(i, '203.0.113.7')).status, 201);
      const res = await post(3, '203.0.113.7');
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal((await post(4, '198.51.100.9')).status, 201, 'another client has its own allowance');
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
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: 'x' }, { 'X-Real-IP': 'junk' })).status, 429);
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { handle: 'p', body: 'y' }, { 'X-Real-IP': '203.0.113.7' })).status, 201, 'a real address keeps its own allowance');
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
});
