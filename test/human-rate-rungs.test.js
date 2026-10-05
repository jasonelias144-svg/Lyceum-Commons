/**
 * Human rate-only rungs from human-antispam-numbers-v0.1.md (no storage caps).
 */
process.env.OPEN_POST_RATE_PER_MIN = '100';
process.env.OPEN_POST_IP_RATE_PER_MIN = '200';
process.env.HUMAN_POST_RATE_PER_MIN = '100';
process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '45';
process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '20';
process.env.HUMAN_POST_IP_RATE_PER_MIN = '120';
process.env.HUMAN_POST_ROOM_RATE_PER_MIN = '90';
process.env.HUMAN_POST_NEW_KEY_BURST = '8';
process.env.HUMAN_POST_NEW_KEY_RAMP_MS = '600000';
process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
process.env.HUMAN_REJOIN_RATE_PER_MIN = '30';
process.env.HUMAN_GUESTBOOK_RATE_PER_MIN = '3';
process.env.HUMAN_STRUCT_RATE_PER_MIN = '6';
process.env.JOIN_SITE_RATE_PER_MIN = '300';
process.env.OPEN_CLIENT_IP_HEADER = 'none';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { guestHeaders, remember } = require('./guest-jar');
const store = require('../src/store');
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

describe('Human rate rungs', () => {
  it('siteJoinSpec shape matches the agreed join-rung contract', () => {
    assert.deepEqual(rateLimit.siteJoinSpec(), { key: 'join:site', limit: 300 });
    assert.equal(rateLimit.DEFAULT_JOIN_SITE_PER_MIN, 300);
    assert.equal(rateLimit.DEFAULT_HUMAN_JOIN_PER_MIN, 10);
    assert.equal(rateLimit.DEFAULT_HUMAN_REJOIN_PER_MIN, 30);
    assert.equal(rateLimit.DEFAULT_HUMAN_ROOM_PER_MIN, 90);
    assert.equal(rateLimit.DEFAULT_HUMAN_NEW_KEY_BURST, 8);
    assert.equal(rateLimit.DEFAULT_HUMAN_GUESTBOOK_PER_MIN, 3);
    assert.equal(rateLimit.DEFAULT_HUMAN_STRUCT_PER_MIN, 6);
  });

  it('prepareJoin and joinHuman agree on skip vs charge and on refusals', () => {
    const room = store.getRoom('welcome');
    assert.equal(store.prepareJoin(room, 'fresh'), 'charge');
    const { guest_key: key } = store.joinHuman(room, 'fresh', null);
    const gid = store.resolveGuest(key);
    assert.equal(store.prepareJoin(room, 'fresh', gid), 'skip', 'present rejoin is free');
    store.leaveHuman(room, 'fresh');
    // Still a member? leave clears membership — so new join with key is charge (new seat)
    // After leave, name is free; with key joining again is brand-new seat → charge
    assert.equal(store.prepareJoin(room, 'fresh', gid), 'charge');
    store.joinHuman(room, 'fresh', gid);
    // Away: expire presence, still member → owned reseat skip
    room.roster.delete('fresh');
    assert.ok(store.isMember(room, 'fresh'));
    assert.equal(store.prepareJoin(room, 'fresh', gid), 'skip', 'owned reseat is free');
    assert.throws(() => store.prepareJoin(room, 'fresh'), (e) => e.code === 'handle_taken');
    assert.throws(() => store.joinHuman(room, 'fresh', null), (e) => e.code === 'handle_taken');
  });

  it('writing joins: 11th minting join/min from one address is 429 with join copy; refusal burns nothing', async () => {
    process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
    process.env.JOIN_SITE_RATE_PER_MIN = '300';
    try {
      for (let i = 0; i < 10; i++) {
        const r = await json('POST', '/api/human/rooms/welcome/join', { handle: `j${i}`, party: 'human' });
        assert.equal(r.status, 200, `join ${i}`);
        assert.match(r.data.guest_key, /^g_/);
      }
      const before = rateLimit._sizes().buckets;
      const refused = await json('POST', '/api/human/rooms/welcome/join', { handle: 'j10', party: 'human' });
      assert.equal(refused.status, 429);
      assert.equal(refused.data.error.code, 'rate_limited');
      assert.match(refused.data.error.message, /joining quickly/i);
      assert.ok(Number(refused.headers.get('retry-after')) >= 1);
      assert.equal(refused.data.guest_key, undefined);
      // Refused join created no guest and did not grow born map for a mint
      assert.equal(store._guests.size, 10);
      // A refusal must not leave a half-spent new bucket behind for a fresh key name
      assert.ok(rateLimit._sizes().buckets <= before + 2);
    } finally {
      process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
    }
  });

  it('owned reseat charges nothing (skip); present rejoin is free', async () => {
    process.env.HUMAN_JOIN_RATE_PER_MIN = '2';
    try {
      const a = await json('POST', '/api/human/rooms/welcome/join', { handle: 'seat', party: 'human' });
      const key = a.data.guest_key;
      // Spend the rest of the join budget with another mint
      assert.equal((await json('POST', '/api/human/rooms/welcome/join', { handle: 'other', party: 'human' })).status, 200);
      assert.equal((await json('POST', '/api/human/rooms/welcome/join', { handle: 'third', party: 'human' })).status, 429);
      // Reseat as seat with key still works
      const again = await json('POST', '/api/human/rooms/welcome/join', { handle: 'seat', party: 'human' }, { 'X-Lyceum-Guest': key });
      assert.equal(again.status, 200);
      assert.equal(again.data.guest_key, undefined);
    } finally {
      process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
    }
  });

  it('many keys from one address: 11th minting join hits address ceiling (attacker row)', async () => {
    process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
    process.env.JOIN_SITE_RATE_PER_MIN = '500';
    try {
      for (let i = 0; i < 10; i++) {
        assert.equal((await json('POST', '/api/human/rooms/welcome/join', { handle: `mk${i}`, party: 'human' })).status, 200);
      }
      const r = await json('POST', '/api/human/rooms/welcome/join', { handle: 'mk10', party: 'human' });
      assert.equal(r.status, 429);
    } finally {
      process.env.JOIN_SITE_RATE_PER_MIN = '300';
    }
  });

  it('rejoin per-key: 31st writing join under one key in a minute is 429', async () => {
    process.env.HUMAN_JOIN_RATE_PER_MIN = '100';
    process.env.HUMAN_REJOIN_RATE_PER_MIN = '30';
    process.env.JOIN_SITE_RATE_PER_MIN = '500';
    try {
      const rooms = [];
      for (let i = 0; i < 32; i++) {
        rooms.push((await json('POST', '/api/human/rooms', {})).data.room_id);
      }
      const first = await json('POST', `/api/human/rooms/${rooms[0]}/join`, { handle: 'thrash', party: 'human' });
      const key = first.data.guest_key;
      assert.match(key, /^g_/);
      // Mint did not charge rejoin. Next 30 keyed new-seat joins spend rejoin 1..30; the 31st keyed is 429.
      // Same name in every room (counts once toward the 5-name cap); each new room is a writing seat.
      for (let i = 1; i <= 30; i++) {
        const r = await json(
          'POST',
          `/api/human/rooms/${rooms[i]}/join`,
          { handle: 'thrash', party: 'human' },
          { 'X-Lyceum-Guest': key }
        );
        assert.equal(r.status, 200, `keyed seat ${i}`);
      }
      const blocked = await json(
        'POST',
        `/api/human/rooms/${rooms[31]}/join`,
        { handle: 'thrash', party: 'human' },
        { 'X-Lyceum-Guest': key }
      );
      assert.equal(blocked.status, 429);
      assert.match(blocked.data.error.message, /joining quickly/i);
    } finally {
      process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
      process.env.HUMAN_REJOIN_RATE_PER_MIN = '30';
      process.env.JOIN_SITE_RATE_PER_MIN = '300';
    }
  });

  it('HUMAN_POST_NEW_KEY_BURST defaults to 8 on the markNew ramp', () => {
    rateLimit._reset();
    delete process.env.HUMAN_POST_NEW_KEY_BURST;
    process.env.HUMAN_POST_IP_RATE_PER_MIN = '200';
    process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '45';
    try {
      assert.equal(rateLimit.DEFAULT_HUMAN_NEW_KEY_BURST, 8);
      const ip = 'ip:198.51.100.40';
      const key = 'human:guest:gst_burst';
      rateLimit.markNew(key);
      let n = 0;
      while (n < 20 && rateLimit.takeHumanPost(ip, key, { format: 'live', roomId: 'welcome' }) === 0) n += 1;
      assert.equal(n, 8);
      assert.ok(rateLimit.takeHumanPost(ip, key, { format: 'live', roomId: 'welcome' }) > 0);
    } finally {
      process.env.HUMAN_POST_NEW_KEY_BURST = '8';
      process.env.HUMAN_POST_IP_RATE_PER_MIN = '120';
    }
  });

  it('room budget: many keys/addresses into one room hit HUMAN_POST_ROOM_RATE_PER_MIN (90)', () => {
    rateLimit._reset();
    process.env.HUMAN_POST_ROOM_RATE_PER_MIN = '90';
    process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '200';
    process.env.HUMAN_POST_IP_RATE_PER_MIN = '500';
    try {
      let n = 0;
      for (let i = 0; i < 100; i++) {
        const ip = `ip:203.0.113.${i % 200}`;
        const key = `human:guest:gst_room_${i}`;
        if (rateLimit.takeHumanPost(ip, key, { format: 'live', roomId: 'welcome' }) === 0) n += 1;
        else break;
      }
      assert.equal(n, 90);
      assert.ok(rateLimit.takeHumanPost('ip:198.51.100.1', 'human:guest:gst_room_x', { format: 'live', roomId: 'welcome' }) > 0);
    } finally {
      process.env.HUMAN_POST_ROOM_RATE_PER_MIN = '90';
      process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '45';
      process.env.HUMAN_POST_IP_RATE_PER_MIN = '120';
    }
  });

  it('guestbook: 4th signature/min from one address is 429; GET stays unlimited', async () => {
    process.env.HUMAN_GUESTBOOK_RATE_PER_MIN = '3';
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal(
          (await json('POST', '/api/guestbook', { handle: `g${i}`, body: `sig ${i}` })).status,
          201
        );
      }
      const r = await json('POST', '/api/guestbook', { handle: 'g3', body: 'too many' });
      assert.equal(r.status, 429);
      assert.equal(r.data.error.code, 'rate_limited');
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
      assert.equal((await json('GET', '/api/guestbook')).status, 200);
    } finally {
      process.env.HUMAN_GUESTBOOK_RATE_PER_MIN = '3';
    }
  });

  it('branch/merge: 7th struct call/min under one key is 429', async () => {
    process.env.HUMAN_STRUCT_RATE_PER_MIN = '6';
    process.env.HUMAN_JOIN_RATE_PER_MIN = '50';
    try {
      const join = await json('POST', '/api/human/rooms/welcome/join', { handle: 'struct', party: 'human' });
      const key = join.data.guest_key;
      const hdr = { 'X-Lyceum-Guest': key };
      for (let i = 0; i < 6; i++) {
        const b = await json(
          'POST',
          '/api/human/rooms/welcome/branch',
          { handle: 'struct', party: 'human' },
          hdr
        );
        assert.equal(b.status, 201, `branch ${i}`);
      }
      const blocked = await json(
        'POST',
        '/api/human/rooms/welcome/branch',
        { handle: 'struct', party: 'human' },
        hdr
      );
      assert.equal(blocked.status, 429);
      assert.equal(blocked.data.error.code, 'rate_limited');
      assert.match(blocked.data.error.message, /posting quickly/i);
    } finally {
      process.env.HUMAN_STRUCT_RATE_PER_MIN = '6';
      process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
    }
  });

  it('refusal burns neither join address nor join:site (atomic take)', () => {
    rateLimit._reset();
    process.env.HUMAN_JOIN_RATE_PER_MIN = '1';
    process.env.JOIN_SITE_RATE_PER_MIN = '1';
    try {
      const ip = 'ip:203.0.113.77';
      assert.equal(rateLimit.takeHumanJoin(ip, null), 0);
      const wait = rateLimit.takeHumanJoin(ip, null);
      assert.ok(wait > 0);
      // After refusal, both buckets still empty of partial spend from the refused call:
      // a different address can still take the site bucket only if site wasn't charged — site was charged on first success.
      // First success spent both. Second refusal must not create orphan buckets that block a fresh address forever beyond site.
      rateLimit._reset();
      process.env.HUMAN_JOIN_RATE_PER_MIN = '0'; // address rung off
      process.env.JOIN_SITE_RATE_PER_MIN = '1';
      assert.equal(rateLimit.takeHumanJoin('ip:1.1.1.1', null), 0);
      assert.ok(rateLimit.takeHumanJoin('ip:2.2.2.2', null) > 0, 'site alone limits after one write');
      // Refuse does not spend: reset and take with wait path leaving no created buckets
      rateLimit._reset();
      process.env.HUMAN_JOIN_RATE_PER_MIN = '1';
      process.env.JOIN_SITE_RATE_PER_MIN = '1';
      assert.equal(rateLimit.takeHumanJoin(ip, null), 0);
      const sizesBefore = rateLimit._sizes().buckets;
      assert.ok(rateLimit.takeHumanJoin(ip, null) > 0);
      assert.equal(rateLimit._sizes().buckets, sizesBefore, 'refused take creates no new buckets');
    } finally {
      process.env.HUMAN_JOIN_RATE_PER_MIN = '10';
      process.env.JOIN_SITE_RATE_PER_MIN = '300';
    }
  });

  it('checkKnobs reads the new Human and JOIN_SITE knobs without throwing', () => {
    rateLimit.checkKnobs();
  });
});
