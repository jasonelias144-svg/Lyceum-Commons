/**
 * Join rate limit: Open per-address join budget, site-wide join backstop across
 * Open and /api/ai (Human joins are not charged yet), idempotent rejoins free,
 * error precedence, knobs = 0 off. Small numbers here.
 */
process.env.OPEN_POST_RATE_PER_MIN = '30';
process.env.OPEN_POST_IP_RATE_PER_MIN = '120';
process.env.HUMAN_POST_RATE_PER_MIN = '30';
process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '45';
process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '20';
process.env.HUMAN_POST_IP_RATE_PER_MIN = '120';
process.env.AI_POST_RATE_PER_MIN = '120';
process.env.AI_POST_IP_RATE_PER_MIN = '120';
process.env.AI_POST_ROOM_RATE_PER_MIN = '240';
process.env.AI_JOIN_IP_RATE_PER_MIN = '20';
process.env.AI_JOIN_AGENT_RATE_PER_MIN = '20';
process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
process.env.JOIN_SITE_RATE_PER_MIN = '50';
const { describe, it, before, after, beforeEach } = require('node:test');
const { guestHeaders, remember } = require('./guest-jar');
const assert = require('node:assert/strict');
const openStore = require('../src/openStore');
const store = require('../src/store');
const aiStore = require('../src/aiStore');
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
  openStore._setClock();
  openStore.clearAll();
  store.clearAll();
  aiStore.clearAll();
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

describe('Join rate limit (Open per-IP + site backstop)', () => {
  async function openRoom() {
    const r = await json('POST', '/api/open/rooms', {});
    assert.equal(r.status, 201);
    return r.data.room_id;
  }
  async function openJoinHuman(roomId, handle, headers = {}) {
    return json('POST', `/api/open/rooms/${roomId}/join`, { handle, party: 'human' }, headers);
  }
  async function openJoinAi(roomId, agent_id, headers = {}) {
    return json('POST', `/api/open/rooms/${roomId}/join`, { agent_id, party: 'ai' }, headers);
  }
  async function aiRegister(agent_id) {
    return json('POST', '/api/ai/rooms', { agent_id, party: 'ai' });
  }
  async function humanJoin(roomId, handle, headers = {}) {
    return json('POST', `/api/human/rooms/${roomId}/join`, { handle, party: 'human' }, headers);
  }

  it('refuses an Open address\'s fourth writing join with 429, Retry-After and a plain message', async () => {
    process.env.JOIN_SITE_RATE_PER_MIN = '100';
    try {
      const room = await openRoom();
      assert.equal((await openJoinHuman(room, 'h1')).status, 200);
      assert.equal((await openJoinHuman(room, 'h2')).status, 200);
      assert.equal((await openJoinHuman(room, 'h3')).status, 200);
      const res = await openJoinHuman(room, 'h4');
      assert.equal(res.status, 429);
      assert.equal(res.data.error.code, 'rate_limited');
      assert.equal(res.data.error.message, "You're posting quickly.");
      assert.doesNotMatch(res.data.error.message, /\d/);
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
    } finally {
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('idempotent Open human rejoin is free', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '2';
    process.env.JOIN_SITE_RATE_PER_MIN = '100';
    try {
      const room = await openRoom();
      const first = await openJoinHuman(room, 'rejoin-h');
      assert.equal(first.status, 200);
      const key = first.data.guest_key;
      assert.ok(key);
      for (let i = 0; i < 5; i++) {
        const r = await openJoinHuman(room, 'rejoin-h', { 'X-Lyceum-Guest': key });
        assert.equal(r.status, 200, `rejoin ${i}`);
        assert.equal(r.data.guest_key, undefined);
      }
      // One write left (first used 1 of 2).
      assert.equal((await openJoinHuman(room, 'other-h')).status, 200);
      const blocked = await openJoinHuman(room, 'third-h');
      assert.equal(blocked.status, 429);
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('idempotent Open AI Bearer rejoin is free', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '2';
    process.env.JOIN_SITE_RATE_PER_MIN = '100';
    try {
      const room = await openRoom();
      const first = await openJoinAi(room, 'rejoin-bot');
      assert.equal(first.status, 200);
      const cred = first.data.credential;
      for (let i = 0; i < 5; i++) {
        const r = await openJoinAi(room, 'rejoin-bot', { Authorization: `Bearer ${cred}` });
        assert.equal(r.status, 200, `AI rejoin ${i}`);
        assert.equal(r.data.credential, cred);
      }
      assert.equal((await openJoinAi(room, 'other-bot')).status, 200);
      assert.equal((await openJoinAi(room, 'third-bot')).status, 429);
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('an Open human owner reseat after presence expiry is free', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '1';
    process.env.JOIN_SITE_RATE_PER_MIN = '100';
    process.env.OPEN_PRESENCE_TTL_MS = '60000'; // 1 min (above the 30s floor)
    const MIN = 60 * 1000;
    // Wall-clock base so presenceEpoch from clearAll (Date.now) lines up with last_seen.
    let t = Date.now();
    openStore._setClock(() => t);
    openStore._setPresenceEpoch(t);
    try {
      const room = await openRoom();
      const first = await openJoinHuman(room, 'away-h');
      assert.equal(first.status, 200);
      const key = first.data.guest_key;
      assert.ok(key);
      // Drop off the roster but keep ownership (expiry, not leave).
      t += 2 * MIN;
      openStore.sweep(openStore.getRoom(room));
      assert.equal(openStore.listRoster(openStore.getRoom(room)).length, 0, 'expired off the roster');
      assert.ok(openStore.ownsHuman(openStore.getRoom(room), 'away-h', openStore.resolveGuest(key)));
      // Open IP budget already spent by the mint; a charged join would 429.
      const reseat = await openJoinHuman(room, 'away-h', { 'X-Lyceum-Guest': key });
      assert.equal(reseat.status, 200, 'owner reseat is free after expiry');
      assert.equal(reseat.data.guest_key, undefined);
      // A fresh mint from the same address is still refused.
      const blocked = await openJoinHuman(room, 'fresh-h');
      assert.equal(blocked.status, 429);
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
      delete process.env.OPEN_PRESENCE_TTL_MS;
      openStore._setClock();
    }
  });

  it('site backstop refuses across mixed Open and /api/ai writing joins once exhausted', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '100';
    process.env.AI_JOIN_IP_RATE_PER_MIN = '100';
    process.env.AI_JOIN_AGENT_RATE_PER_MIN = '100';
    process.env.JOIN_SITE_RATE_PER_MIN = '3';
    try {
      rateLimit._reset();
      const openId = await openRoom();
      assert.equal((await openJoinHuman(openId, 'site-o')).status, 200);
      assert.equal((await aiRegister('site-ai')).status, 201);
      assert.equal((await openJoinAi(openId, 'site-oa')).status, 200);
      // Fourth writing join → site 429.
      const blocked = await openJoinHuman(openId, 'site-o2');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.data.error.code, 'rate_limited');
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.AI_JOIN_IP_RATE_PER_MIN = '20';
      process.env.AI_JOIN_AGENT_RATE_PER_MIN = '20';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('Human writing joins do not charge the site bucket', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '100';
    process.env.JOIN_SITE_RATE_PER_MIN = '1';
    try {
      rateLimit._reset();
      const openId = await openRoom();
      assert.equal((await openJoinHuman(openId, 'site-burn')).status, 200);
      // Site exhausted for Open/AI; Human join must still succeed.
      const hum = await humanJoin('welcome', 'site-hum');
      assert.equal(hum.status, 200);
      assert.ok(hum.data.guest_key);
      // Open still sees the exhausted site bucket.
      const blocked = await openJoinHuman(openId, 'site-burn2');
      assert.equal(blocked.status, 429);
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('handle_taken keeps precedence over rate_limited on Open join', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '1';
    process.env.JOIN_SITE_RATE_PER_MIN = '100';
    try {
      const room = await openRoom();
      const first = await openJoinHuman(room, 'taken-h');
      assert.equal(first.status, 200);
      // IP budget spent; a conflicting keyless join must still be handle_taken
      // (pass an empty guest header so the test jar does not auto-attach the owner's key).
      const res = await openJoinHuman(room, 'taken-h', { 'X-Lyceum-Guest': '' });
      assert.equal(res.status, 409);
      assert.equal(res.data.error.code, 'handle_taken');
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('handle_taken keeps precedence over rate_limited on Open AI join', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '1';
    process.env.JOIN_SITE_RATE_PER_MIN = '100';
    try {
      const room = await openRoom();
      const first = await openJoinAi(room, 'taken-bot');
      assert.equal(first.status, 200);
      const res = await openJoinAi(room, 'taken-bot');
      assert.equal(res.status, 409);
      assert.equal(res.data.error.code, 'handle_taken');
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('OPEN_JOIN_IP_RATE_PER_MIN=0 and JOIN_SITE_RATE_PER_MIN=0 turn rungs off', () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '0';
    process.env.JOIN_SITE_RATE_PER_MIN = '0';
    process.env.AI_JOIN_IP_RATE_PER_MIN = '0';
    process.env.AI_JOIN_AGENT_RATE_PER_MIN = '0';
    try {
      rateLimit._reset();
      for (let i = 0; i < 50; i++) {
        assert.equal(rateLimit.takeOpenJoin('ip:9.9.9.9'), 0);
        assert.equal(rateLimit.takeAiJoin('ip:9.9.9.9', `a${i}`), 0);
      }
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
      process.env.AI_JOIN_IP_RATE_PER_MIN = '20';
      process.env.AI_JOIN_AGENT_RATE_PER_MIN = '20';
    }
  });

  it('fallback address uses the AI agent default (6) for Open joins', () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '12';
    process.env.JOIN_SITE_RATE_PER_MIN = '0';
    try {
      rateLimit._reset();
      for (let i = 0; i < 6; i++) {
        assert.equal(rateLimit.takeOpenJoin(rateLimit.FALLBACK_KEY), 0, `fallback ${i}`);
      }
      assert.ok(rateLimit.takeOpenJoin(rateLimit.FALLBACK_KEY) > 0, 'seventh fallback Open join refused');
      // A known address still has its own OPEN_JOIN_IP budget.
      for (let i = 0; i < 12; i++) {
        assert.equal(rateLimit.takeOpenJoin('ip:203.0.113.9'), 0, `known ${i}`);
      }
      assert.ok(rateLimit.takeOpenJoin('ip:203.0.113.9') > 0);
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('take() refusal does not burn other buckets (site + Open IP atomic)', () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '5';
    process.env.JOIN_SITE_RATE_PER_MIN = '2';
    try {
      rateLimit._reset();
      assert.equal(rateLimit.takeOpenJoin('ip:1.1.1.1'), 0);
      assert.equal(rateLimit.takeOpenJoin('ip:1.1.1.1'), 0);
      // Site exhausted; third Open join refused — must not spend the per-IP bucket.
      assert.ok(rateLimit.takeOpenJoin('ip:1.1.1.1') > 0);
      // Turn site off; the same address still has 3 of its 5 left.
      process.env.JOIN_SITE_RATE_PER_MIN = '0';
      assert.equal(rateLimit.takeOpenJoin('ip:1.1.1.1'), 0);
      assert.equal(rateLimit.takeOpenJoin('ip:1.1.1.1'), 0);
      assert.equal(rateLimit.takeOpenJoin('ip:1.1.1.1'), 0);
      assert.ok(rateLimit.takeOpenJoin('ip:1.1.1.1') > 0);
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });

  it('checkKnobs lists the new join knobs', () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      rateLimit._reset();
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = 'nope';
      process.env.JOIN_SITE_RATE_PER_MIN = 'nope';
      rateLimit.checkKnobs();
      assert.equal(warnings.filter((w) => w.includes('OPEN_JOIN_IP_RATE_PER_MIN')).length, 1);
      assert.equal(warnings.filter((w) => w.includes('JOIN_SITE_RATE_PER_MIN')).length, 1);
    } finally {
      console.warn = warn;
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
      rateLimit._reset();
    }
  });

  it('Open-composition AI writing joins count toward Open per-IP (not AI join IP)', async () => {
    process.env.OPEN_JOIN_IP_RATE_PER_MIN = '2';
    process.env.AI_JOIN_IP_RATE_PER_MIN = '100';
    process.env.JOIN_SITE_RATE_PER_MIN = '100';
    try {
      const room = await openRoom();
      assert.equal((await openJoinAi(room, 'oa1')).status, 200);
      assert.equal((await openJoinAi(room, 'oa2')).status, 200);
      const blocked = await openJoinAi(room, 'oa3');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.data.error.code, 'rate_limited');
    } finally {
      process.env.OPEN_JOIN_IP_RATE_PER_MIN = '3';
      process.env.AI_JOIN_IP_RATE_PER_MIN = '20';
      process.env.JOIN_SITE_RATE_PER_MIN = '50';
    }
  });
});
