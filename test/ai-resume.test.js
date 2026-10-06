/**
 * AI resume with proof: a seat that idled out can join its free handle again with its expired
 * credential as Bearer and keep its post-rate ramp / earn-out state (no markNew). Without that
 * token, or with another seat's token, the join is a fresh mint on the full new-key ramp.
 * Both clocks (aiStore and rateLimit) are injected, so nothing sleeps.
 */
// The shipped AI post defaults: 120/min per credential, new credentials burst 10, 15 min ramp,
// earn-out after 50 posts. Joins are off except where a test turns one on.
process.env.AI_POST_RATE_PER_MIN = '120';
process.env.AI_POST_IP_RATE_PER_MIN = '120';
process.env.AI_POST_ROOM_RATE_PER_MIN = '240';
process.env.AI_POST_NEW_KEY_BURST = '10';
process.env.AI_POST_NEW_KEY_RAMP_MS = String(15 * 60 * 1000);
process.env.AI_POST_EARN_OUT_POSTS = '50';
process.env.AI_JOIN_IP_RATE_PER_MIN = '0';
process.env.AI_JOIN_AGENT_RATE_PER_MIN = '0';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const aiStore = require('../src/aiStore');
const rateLimit = require('../src/rateLimit');

const TTL = aiStore.DEFAULT_PRESENCE_TTL_MS;

let server;
let base;
let t;

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
  t = 50_000_000_000;
  rateLimit._reset();
  rateLimit._setClock(() => t);
  aiStore._setClock(() => t);
  aiStore.clearAll();
});

afterEach(() => {
  aiStore._setClock();
  aiStore.clearAll();
  rateLimit._reset();
  process.env.AI_JOIN_IP_RATE_PER_MIN = '0';
});

async function send(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const join = (agentId, token, room = 'ai-welcome') =>
  send('POST', `/api/ai/rooms/${room}/join`, { party: 'ai', agent_id: agentId }, token);
const read = (token, room = 'ai-welcome') => send('GET', `/api/ai/rooms/${room}/messages`, undefined, token);
const post = (token, body, room = 'ai-welcome') => send('POST', `/api/ai/rooms/${room}/post`, { body }, token);

/** Join and post 50 times (5 s apart, inside the ramp), so the seat earns out to the full rate. */
async function earnOut(agentId, room = 'ai-welcome') {
  const onRamp = rateLimit._sizes().born;
  const j = await join(agentId, undefined, room);
  assert.equal(j.status, 200);
  for (let i = 0; i < 50; i++) {
    t += 5000;
    assert.equal((await post(j.data.credential, `earn ${i}`, room)).status, 201, `earn post ${i}`);
  }
  assert.equal(rateLimit._sizes().born, onRamp, 'earned out');
  return j.data.credential;
}

/** Let every seat idle out, and sweep now so expired_at is now. */
function expireAll(room = 'ai-welcome') {
  t += TTL + 1;
  assert.equal(aiStore.getRoom(room).roster.size, 0);
}

/** How many quick posts (same instant) go through before the first 429, up to `max`. */
async function quickPosts(token, max, room = 'ai-welcome') {
  for (let i = 0; i < max; i++) {
    const r = await post(token, `quick ${i}`, room);
    if (r.status === 429) {
      assert.equal(r.data.error.code, 'rate_limited');
      return i;
    }
    assert.equal(r.status, 201);
  }
  return max;
}

describe('AI resume with proof', () => {
  it('an earned-out agent that idles out and rejoins with its old Bearer keeps the full 120/min rate; the old token stays 401', async () => {
    const old = await earnOut('steady-bot');
    expireAll();
    assert.equal((await post(old, 'late')).status, 401);

    const back = await join('steady-bot', old);
    assert.equal(back.status, 200);
    assert.notEqual(back.data.credential, old);
    assert.equal(rateLimit._sizes().born, 0, 'no markNew on resume');
    assert.equal(await quickPosts(back.data.credential, 121), 120);

    // The old token only proved the resume: it never acts as the seat.
    assert.equal((await post(old, 'still late')).status, 401);
    assert.equal((await read(old)).status, 401);
    assert.equal((await send('POST', '/api/ai/rooms/ai-welcome/leave', {}, old)).status, 401);
  });

  it('the same flow without the old Bearer is a fresh mint back on the new-key burst of 10', async () => {
    await earnOut('steady-bot');
    expireAll();
    const back = await join('steady-bot');
    assert.equal(back.status, 200);
    assert.equal(await quickPosts(back.data.credential, 20), 10);
  });

  it('a token from a different seat or another room does not resume, and is not used up', async () => {
    const room = (await send('POST', '/api/ai/rooms', { party: 'ai', agent_id: 'steady-bot' })).data;
    const mine = await earnOut('steady-bot');
    const beta = (await join('beta-bot')).data.credential;
    expireAll();
    assert.equal(aiStore.getRoom(room.room_id).roster.size, 0);

    // Another agent's expired token in the same room: fresh mint.
    const asBeta = await join('steady-bot', beta);
    assert.equal(asBeta.status, 200);
    assert.equal(await quickPosts(asBeta.data.credential, 20), 10);
    await send('POST', '/api/ai/rooms/ai-welcome/leave', {}, asBeta.data.credential);

    // The same agent_id's token from another room: fresh mint there.
    const elsewhere = await join('steady-bot', mine, room.room_id);
    assert.equal(elsewhere.status, 200);
    assert.equal(await quickPosts(elsewhere.data.credential, 20, room.room_id), 10);

    // beta-bot's own token still resumes beta-bot (both entries were left alone).
    assert.ok(aiStore._resumable.has(aiStore.hashCredential(mine)));
    assert.ok(aiStore._resumable.has(aiStore.hashCredential(beta)));
    rateLimit._reset();
    rateLimit._setClock(() => t);
    const betaBack = await join('beta-bot', beta);
    assert.equal(betaBack.status, 200);
    assert.equal(rateLimit._sizes().born, 0, 'beta-bot resumed');
  });

  it('a resume is one-shot: the same old token cannot resume a second time', async () => {
    const old = await earnOut('steady-bot');
    expireAll();
    const first = await join('steady-bot', old);
    assert.equal(first.status, 200);
    assert.equal(rateLimit._sizes().born, 0);

    expireAll();
    const second = await join('steady-bot', old);
    assert.equal(second.status, 200);
    assert.equal(rateLimit._sizes().born, 1, 'fresh mint: markNew');
    assert.equal(await quickPosts(second.data.credential, 20), 10);
  });

  it('a resume join is charged against the join budget like any writing join, and a refused one keeps its proof', async () => {
    process.env.AI_JOIN_IP_RATE_PER_MIN = '1';
    const old = await earnOut('steady-bot'); // join 1 (the bucket refills during the TTL below)
    expireAll();
    assert.equal((await join('other-bot')).status, 200); // uses this minute's one join
    const refused = await join('steady-bot', old);
    assert.equal(refused.status, 429);
    assert.equal(refused.data.error.code, 'rate_limited');
    assert.equal(aiStore._resumable.size, 1, 'a refused join does not use up the old token');

    t += 60 * 1000;
    const back = await join('steady-bot', old); // charged: uses the refilled join
    assert.equal(back.status, 200);
    assert.equal(rateLimit._sizes().born, 1, 'only other-bot is on the ramp');
    assert.equal(aiStore._resumable.size, 0);
    const next = await join('third-bot');
    assert.equal(next.status, 429, 'the resume took this minute\'s join');
  });

  it('an old token past the retention window does not resume (memory only, bounded)', async () => {
    const keep = (await join('early-bot')).data.credential;
    const lose = (await join('late-bot')).data.credential;
    t += 20 * 60 * 1000; // both past the 15 min time ramp: established
    expireAll();
    assert.equal(aiStore._resumable.size, 2);

    t += aiStore.RESUME_RETENTION_MS - 1000;
    const early = await join('early-bot', keep);
    assert.equal(early.status, 200);
    assert.equal(await quickPosts(early.data.credential, 20), 20, 'resumed: still established');

    t += 2000;
    const late = await join('late-bot', lose);
    assert.equal(late.status, 200);
    assert.equal(await quickPosts(late.data.credential, 20), 10, 'too old: fresh mint');
    assert.equal(aiStore._resumable.size, 0, 'pruned');
    assert.equal(aiStore.RESUME_MAX, 10000);
  });

  it('leaving does not leave a resume behind', async () => {
    const old = await earnOut('polite-bot');
    assert.equal((await send('POST', '/api/ai/rooms/ai-welcome/leave', {}, old)).status, 200);
    assert.equal(aiStore._resumable.size, 0);
    const back = await join('polite-bot', old);
    assert.equal(back.status, 200);
    assert.equal(await quickPosts(back.data.credential, 20), 10);
  });
});
