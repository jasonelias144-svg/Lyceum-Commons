/**
 * AI stream (/api/ai) rate limit: per credential, per address and per room post budgets, the
 * new-credential burst/ramp/earn-out, and per-address / per-agent_id join limits, all with the
 * same 429 shape as Open and Human. Small numbers here. Open-composition AI stays on Open's bucket.
 */
process.env.OPEN_POST_RATE_PER_MIN = '3';
process.env.OPEN_POST_IP_RATE_PER_MIN = '5';
process.env.HUMAN_POST_RATE_PER_MIN = '2';
process.env.HUMAN_LIVE_POST_RATE_PER_MIN = '2';
process.env.HUMAN_BOARD_POST_RATE_PER_MIN = '2';
process.env.HUMAN_POST_IP_RATE_PER_MIN = '5';
process.env.AI_POST_RATE_PER_MIN = '3';
process.env.AI_POST_IP_RATE_PER_MIN = '5';
process.env.AI_POST_ROOM_RATE_PER_MIN = '4';
process.env.AI_POST_NEW_KEY_BURST = '2';
process.env.AI_POST_NEW_KEY_RAMP_MS = '600000';
process.env.AI_POST_EARN_OUT_POSTS = '50';
process.env.AI_JOIN_IP_RATE_PER_MIN = '3';
process.env.AI_JOIN_AGENT_RATE_PER_MIN = '2';
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

describe('AI stream (/api/ai) rate limit', () => {
  async function register(agent_id) {
    return json('POST', '/api/ai/rooms', { agent_id, party: 'ai' });
  }
  async function join(roomId, agent_id, headers = {}) {
    return json('POST', `/api/ai/rooms/${roomId}/join`, { agent_id, party: 'ai' }, headers);
  }
  async function post(roomId, cred, body, headers = {}) {
    return json('POST', `/api/ai/rooms/${roomId}/post`, { body }, {
      Authorization: `Bearer ${cred}`,
      ...headers,
    });
  }

  it('refuses a credential\'s fourth post in a minute with 429, Retry-After and a plain message', async () => {
    // Burst is 2 in this file; raise it so the per-cred limit (3) is what bites.
    process.env.AI_POST_NEW_KEY_BURST = '10';
    process.env.AI_POST_EARN_OUT_POSTS = '0';
    try {
      const reg = await register('bot-a');
      assert.equal(reg.status, 201);
      const roomId = reg.data.room_id;
      const cred = reg.data.credential;
      assert.equal((await post(roomId, cred, 'one')).status, 201);
      assert.equal((await post(roomId, cred, 'two')).status, 201);
      assert.equal((await post(roomId, cred, 'three')).status, 201);
      const res = await post(roomId, cred, 'four');
      assert.equal(res.status, 429);
      assert.equal(res.data.error.code, 'rate_limited');
      assert.equal(res.data.error.message, "You're posting quickly.");
      assert.doesNotMatch(res.data.error.message, /\d/);
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal(aiStore.getRoom(roomId).messages.length, 3);
    } finally {
      process.env.AI_POST_NEW_KEY_BURST = '2';
      process.env.AI_POST_EARN_OUT_POSTS = '50';
    }
  });

  it('every credential from one address shares the AI address ceiling', async () => {
    process.env.AI_POST_NEW_KEY_BURST = '10';
    process.env.AI_POST_EARN_OUT_POSTS = '0';
    process.env.AI_POST_ROOM_RATE_PER_MIN = '20';
    process.env.AI_JOIN_IP_RATE_PER_MIN = '20';
    try {
      const a = await register('ceil-a');
      const roomId = a.data.room_id;
      const b = await join(roomId, 'ceil-b');
      assert.equal(b.status, 200);
      // Per-cred 3, IP 5: 3 from a + 2 from b = 5, then 429.
      for (let i = 0; i < 3; i++) {
        assert.equal((await post(roomId, a.data.credential, `a${i}`)).status, 201);
      }
      assert.equal((await post(roomId, b.data.credential, 'b0')).status, 201);
      assert.equal((await post(roomId, b.data.credential, 'b1')).status, 201);
      const res = await post(roomId, b.data.credential, 'b2');
      assert.equal(res.status, 429, 'sixth post from the address');
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal(aiStore.getRoom(roomId).messages.length, 5);
    } finally {
      process.env.AI_POST_NEW_KEY_BURST = '2';
      process.env.AI_POST_EARN_OUT_POSTS = '50';
      process.env.AI_POST_ROOM_RATE_PER_MIN = '4';
      process.env.AI_JOIN_IP_RATE_PER_MIN = '3';
    }
  });

  it('posts into one room share AI_POST_ROOM_RATE_PER_MIN; another room is separate', async () => {
    process.env.AI_POST_NEW_KEY_BURST = '10';
    process.env.AI_POST_EARN_OUT_POSTS = '0';
    process.env.AI_POST_RATE_PER_MIN = '10';
    process.env.AI_POST_IP_RATE_PER_MIN = '20';
    process.env.AI_POST_ROOM_RATE_PER_MIN = '3';
    process.env.AI_JOIN_IP_RATE_PER_MIN = '20';
    try {
      const a = await register('room-a');
      const b = await register('room-b');
      // Same address, two rooms. Fill room A's budget (3).
      for (let i = 0; i < 3; i++) {
        assert.equal((await post(a.data.room_id, a.data.credential, `a${i}`)).status, 201);
      }
      const blocked = await post(a.data.room_id, a.data.credential, 'a3');
      assert.equal(blocked.status, 429, "room A's fourth post");
      // Same credential cannot help room A, but room B still has its own budget.
      // room-b is a different credential; post there succeeds.
      assert.equal((await post(b.data.room_id, b.data.credential, 'b0')).status, 201);
    } finally {
      process.env.AI_POST_NEW_KEY_BURST = '2';
      process.env.AI_POST_EARN_OUT_POSTS = '50';
      process.env.AI_POST_RATE_PER_MIN = '3';
      process.env.AI_POST_IP_RATE_PER_MIN = '5';
      process.env.AI_POST_ROOM_RATE_PER_MIN = '4';
      process.env.AI_JOIN_IP_RATE_PER_MIN = '3';
    }
  });

  it('a new AI credential starts at AI_POST_NEW_KEY_BURST', async () => {
    // Default burst in this file is 2; third quick post → 429.
    const reg = await register('fresh-ai');
    const roomId = reg.data.room_id;
    const cred = reg.data.credential;
    assert.equal((await post(roomId, cred, 'm0')).status, 201);
    assert.equal((await post(roomId, cred, 'm1')).status, 201);
    const res = await post(roomId, cred, 'm2');
    assert.equal(res.status, 429);
    assert.equal(res.data.error.code, 'rate_limited');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
  });

  it('earn-out jumps a new credential to the full rate after N accepted posts', () => {
    process.env.AI_POST_RATE_PER_MIN = '30';
    process.env.AI_POST_IP_RATE_PER_MIN = '120';
    process.env.AI_POST_ROOM_RATE_PER_MIN = '240';
    process.env.AI_POST_NEW_KEY_BURST = '5';
    process.env.AI_POST_NEW_KEY_RAMP_MS = '3600000'; // 1h — still mid-ramp without earn-out
    process.env.AI_POST_EARN_OUT_POSTS = '5';
    try {
      rateLimit._reset();
      let t = 7_000_000;
      rateLimit._setClock(() => t);
      const key = 'aiapi:earn:bot';
      rateLimit.markNew(key);
      for (let i = 0; i < 5; i++) {
        assert.equal(rateLimit.takeAiPost('ip:203.0.113.50', key, 'earn'), 0, `earn post ${i}`);
      }
      assert.equal(rateLimit._sizes().born, 0, 'earn-out cleared the ramp');
      // At full rate 30, 2s yields 1 token; at burst 5 mid-ramp, 2s yields ~0.17 — not enough.
      t += 2000;
      assert.equal(rateLimit.takeAiPost('ip:203.0.113.50', key, 'earn'), 0, 'full rate after earn-out');
    } finally {
      process.env.AI_POST_RATE_PER_MIN = '3';
      process.env.AI_POST_IP_RATE_PER_MIN = '5';
      process.env.AI_POST_ROOM_RATE_PER_MIN = '4';
      process.env.AI_POST_NEW_KEY_BURST = '2';
      process.env.AI_POST_NEW_KEY_RAMP_MS = '600000';
      process.env.AI_POST_EARN_OUT_POSTS = '50';
    }
  });

  it('AI_POST_RATE_PER_MIN=0 turns AI post limits off', () => {
    process.env.AI_POST_RATE_PER_MIN = '0';
    try {
      rateLimit._reset();
      for (let i = 0; i < 100; i++) {
        assert.equal(rateLimit.takeAiPost('ip:1.2.3.4', 'aiapi:r:k', 'r'), 0);
      }
    } finally {
      process.env.AI_POST_RATE_PER_MIN = '3';
    }
  });

  it('a bad AI knob warns once; checkKnobs lists every AI knob', () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      rateLimit._reset();
      process.env.AI_POST_RATE_PER_MIN = 'nope';
      rateLimit.checkKnobs();
      assert.equal(warnings.filter((w) => w.includes('AI_POST_RATE_PER_MIN')).length, 1);
      assert.equal(rateLimit.takeAiPost('ip:1.1.1.1', 'aiapi:r:k', 'r'), 0);
      assert.equal(warnings.filter((w) => w.includes('AI_POST_RATE_PER_MIN')).length, 1);
    } finally {
      console.warn = warn;
      process.env.AI_POST_RATE_PER_MIN = '3';
      rateLimit._reset();
    }
  });

  it('AI joins are limited per address and per agent_id', async () => {
    // IP=3, agent=2 in this file. Fourth register/join from the address → 429.
    assert.equal((await register('join-1')).status, 201);
    assert.equal((await register('join-2')).status, 201);
    assert.equal((await register('join-3')).status, 201);
    const res = await register('join-4');
    assert.equal(res.status, 429);
    assert.equal(res.data.error.code, 'rate_limited');
    assert.equal(res.data.error.message, "You're posting quickly.");
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
  });

  it('idempotent Bearer re-join does not charge the join budget', async () => {
    process.env.AI_JOIN_IP_RATE_PER_MIN = '2';
    process.env.AI_JOIN_AGENT_RATE_PER_MIN = '10';
    try {
      const reg = await register('rejoin-bot');
      assert.equal(reg.status, 201);
      const roomId = reg.data.room_id;
      const cred = reg.data.credential;
      // Second write from this address would exhaust IP=2; re-joins must not count.
      for (let i = 0; i < 5; i++) {
        const r = await join(roomId, 'rejoin-bot', { Authorization: `Bearer ${cred}` });
        assert.equal(r.status, 200, `re-join ${i}`);
        assert.equal(r.data.credential, cred);
      }
      // A fresh mint from the same address still has one write left (register used 1 of 2).
      assert.equal((await join(roomId, 'other-bot')).status, 200);
      // Third write → 429.
      const blocked = await join(roomId, 'third-bot');
      assert.equal(blocked.status, 429);
    } finally {
      process.env.AI_JOIN_IP_RATE_PER_MIN = '3';
      process.env.AI_JOIN_AGENT_RATE_PER_MIN = '2';
    }
  });

  it('handle_taken keeps precedence over rate_limited on join', async () => {
    process.env.AI_JOIN_IP_RATE_PER_MIN = '1';
    try {
      const reg = await register('taken-bot');
      assert.equal(reg.status, 201);
      // IP budget already spent by register; a conflicting join must still be handle_taken.
      const res = await join(reg.data.room_id, 'taken-bot');
      assert.equal(res.status, 409);
      assert.equal(res.data.error.code, 'handle_taken');
    } finally {
      process.env.AI_JOIN_IP_RATE_PER_MIN = '3';
    }
  });

  it('invalid_credential keeps precedence over rate_limited on post', async () => {
    const reg = await register('cred-bot');
    // Burn the post allowance.
    process.env.AI_POST_NEW_KEY_BURST = '10';
    process.env.AI_POST_EARN_OUT_POSTS = '0';
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await post(reg.data.room_id, reg.data.credential, `m${i}`)).status, 201);
      }
      const bad = await json(
        'POST',
        `/api/ai/rooms/${reg.data.room_id}/post`,
        { body: 'nope' },
        { Authorization: 'Bearer deadbeef' }
      );
      assert.equal(bad.status, 401);
      assert.equal(bad.data.error.code, 'invalid_credential');
    } finally {
      process.env.AI_POST_NEW_KEY_BURST = '2';
      process.env.AI_POST_EARN_OUT_POSTS = '50';
    }
  });

  it('Open-composition AI posts stay on Open\'s bucket (unchanged)', async () => {
    const a = (await json('POST', '/api/open/rooms', { title: 'open-ai' })).data.room_id;
    const bot = (await json('POST', `/api/open/rooms/${a}/join`, { agent_id: 'open-bot', party: 'ai' })).data;
    const auth = { Authorization: `Bearer ${bot.credential}` };
    // Open per-key is 3, burst 5 — so 3 posts then... wait, new key burst is 5 for Open.
    // With OPEN_POST_RATE_PER_MIN=3 and default burst 5, burst caps at limit when burst>=limit
    // in allowance: "if (burst >= limit || !ramp) return limit" — so established=3, new also 3.
    for (let i = 0; i < 3; i++) {
      assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { body: `m${i}` }, auth)).status, 201);
    }
    assert.equal((await json('POST', `/api/open/rooms/${a}/post`, { body: 'm3' }, auth)).status, 429);
  });

  it('AI_JOIN_* = 0 turns join limits off', () => {
    process.env.AI_JOIN_IP_RATE_PER_MIN = '0';
    process.env.AI_JOIN_AGENT_RATE_PER_MIN = '0';
    try {
      rateLimit._reset();
      for (let i = 0; i < 50; i++) {
        assert.equal(rateLimit.takeAiJoin('ip:9.9.9.9', `agent-${i}`), 0);
      }
    } finally {
      process.env.AI_JOIN_IP_RATE_PER_MIN = '3';
      process.env.AI_JOIN_AGENT_RATE_PER_MIN = '2';
    }
  });
});
