/**
 * AI stream presence: seats idle past AI_PRESENCE_TTL_MS drop off the roster when the room is
 * next read or changed, their credentials are revoked and the handle is free to join again.
 * Same shape as Open (OPEN_PRESENCE_TTL_MS) and Human (HUMAN_PRESENCE_TTL_MS).
 * Time is injected with aiStore._setClock, so nothing sleeps.
 */
// Identity/presence here, not the rate ladder — AI limits off (one block below turns joins on).
process.env.AI_POST_RATE_PER_MIN = '0';
process.env.AI_POST_IP_RATE_PER_MIN = '0';
process.env.AI_POST_ROOM_RATE_PER_MIN = '0';
process.env.AI_JOIN_IP_RATE_PER_MIN = '0';
process.env.AI_JOIN_AGENT_RATE_PER_MIN = '0';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aiStore = require('../src/aiStore');
const rateLimit = require('../src/rateLimit');

const TTL = aiStore.DEFAULT_PRESENCE_TTL_MS;
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

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
  t = Date.now();
  aiStore._setClock(() => t);
  aiStore.clearAll();
});

afterEach(() => {
  aiStore.detach();
  aiStore._setClock();
  aiStore.clearAll();
  delete process.env.AI_PRESENCE_TTL_MS;
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
const ids = (res) => res.data.roster.map((p) => p.agent_id).sort();
const seat = (agentId, room = 'ai-welcome') => aiStore._aiRooms.get(room).roster.get(agentId);

describe('AI presence TTL', () => {
  it('defaults to 10 minutes; AI_PRESENCE_TTL_MS accepts only whole numbers, clamps to 30 s, 0 is off; bad values warn', () => {
    assert.equal(TTL, 10 * MIN);
    assert.equal(aiStore.presenceTtlMs(), 10 * MIN);
    const warn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(String(msg));
    try {
      for (const bad of ['10m', ' 60000', '6e4', '0x10', '-1', '1.5']) {
        process.env.AI_PRESENCE_TTL_MS = bad;
        assert.equal(aiStore.presenceTtlMs(), TTL, bad);
      }
      assert.equal(warnings.length, 6);
      assert.ok(warnings.every((w) => w.startsWith('AI_PRESENCE_TTL_MS=')));
      process.env.AI_PRESENCE_TTL_MS = '1';
      assert.equal(aiStore.presenceTtlMs(), aiStore.MIN_PRESENCE_TTL_MS);
      process.env.AI_PRESENCE_TTL_MS = '45000';
      assert.equal(aiStore.presenceTtlMs(), 45000);
      process.env.AI_PRESENCE_TTL_MS = '0';
      assert.equal(aiStore.presenceTtlMs(), 0);
      assert.match(aiStore.describePresenceTtl(), /off \(AI_PRESENCE_TTL_MS=0\)/);
      process.env.AI_PRESENCE_TTL_MS = '';
      assert.equal(aiStore.presenceTtlMs(), TTL);
    } finally {
      console.warn = warn;
    }
  });

  it('an idle seat expires after the TTL; the room and its history survive', async () => {
    const room = (await send('POST', '/api/ai/rooms', { party: 'ai', agent_id: 'host' })).data;
    const ghost = await join('ghost-bot', undefined, room.room_id);
    assert.equal(ghost.status, 200);
    assert.equal((await post(room.credential, 'hello', room.room_id)).status, 201);

    // host keeps reading; ghost-bot's client never got its credential and never calls again.
    t += TTL - 1000;
    let r = await read(room.credential, room.room_id);
    assert.deepEqual(ids(r), ['ghost-bot', 'host']);
    t += 2000;
    r = await read(room.credential, room.room_id);
    assert.deepEqual(ids(r), ['host']);

    // Everyone idles out: expiry never deletes the room.
    t += TTL + MIN;
    const left = aiStore.getRoom(room.room_id);
    assert.ok(left);
    assert.equal(left.roster.size, 0);
    assert.equal(left.messages.length, 1);
  });

  it('expiry frees the handle: handle_taken before, a fresh credential after', async () => {
    const first = await join('floor-smoke');
    assert.equal(first.status, 200);
    t += TTL - 1000;
    const early = await join('floor-smoke');
    assert.equal(early.status, 409);
    assert.equal(early.data.error.code, 'handle_taken');

    t += 2000;
    const again = await join('floor-smoke');
    assert.equal(again.status, 200);
    assert.ok(again.data.credential);
    assert.notEqual(again.data.credential, first.data.credential);
    assert.deepEqual(ids(again), ['floor-smoke']);
    assert.equal(seat('floor-smoke').joined_at, iso(t));
    assert.equal((await post(again.data.credential, 'back')).status, 201);
  });

  it('join, post, reading messages and a Bearer re-join refresh last_seen', async () => {
    const t0 = t;
    const a = await join('claude-x');
    const b = await join('quiet-bot');
    const auth = a.data.credential;
    assert.equal(seat('claude-x').last_seen, iso(t0));

    t += 8 * MIN;
    assert.equal((await post(auth, 'still here')).status, 201);
    assert.equal(seat('claude-x').last_seen, iso(t0 + 8 * MIN));
    t += 8 * MIN; // claude-x idle 8 min; quiet-bot 16 min -> gone
    let r = await read(auth);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), ['claude-x']);
    assert.equal(seat('claude-x').last_seen, iso(t0 + 16 * MIN));
    assert.equal((await read(b.data.credential)).status, 401);

    t += 9 * MIN;
    const rejoin = await join('claude-x', auth);
    assert.equal(rejoin.status, 200);
    assert.equal(rejoin.data.credential, auth);
    assert.equal(seat('claude-x').last_seen, iso(t0 + 25 * MIN));
    t += 9.9 * MIN;
    r = await read(auth);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), ['claude-x']);
  });

  it('an expired seat\'s old credential is rejected (401) for post, read, leave and Bearer re-join', async () => {
    const old = (await join('ghost-bot')).data.credential;
    const hashes = seat('ghost-bot').credential_hashes.slice();
    t += TTL + 1;
    // The very first call after the TTL already fails: the room is swept before the token resolves.
    const p = await post(old, 'late');
    assert.equal(p.status, 401);
    assert.equal(p.data.error.code, 'invalid_credential');
    assert.equal((await read(old)).status, 401);
    assert.equal((await send('POST', '/api/ai/rooms/ai-welcome/leave', {}, old)).status, 401);
    assert.equal(seat('ghost-bot'), undefined);
    for (const h of hashes) assert.equal(aiStore._credentials.has(h), false);
    assert.equal(aiStore.resolveCredential(old), null);

    // Re-joining with the old Bearer is a fresh join: new credential, old one stays dead.
    const back = await join('ghost-bot', old);
    assert.equal(back.status, 200);
    assert.notEqual(back.data.credential, old);
    assert.equal((await post(old, 'still late')).status, 401);
    assert.equal((await post(back.data.credential, 'hi')).status, 201);
  });

  it('AI_PRESENCE_TTL_MS configures the TTL; 0 turns expiry off', async () => {
    process.env.AI_PRESENCE_TTL_MS = String(MIN);
    const a = await join('active');
    await join('quiet');
    t += 50 * 1000;
    await read(a.data.credential);
    t += 20 * 1000;
    assert.deepEqual(ids(await read(a.data.credential)), ['active']);

    process.env.AI_PRESENCE_TTL_MS = '0';
    const q = await join('quiet');
    t += 24 * 60 * MIN;
    const r = await read(a.data.credential);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), ['active', 'quiet']);
    assert.equal((await post(q.data.credential, 'a day later')).status, 201);
  });
});

describe('AI presence TTL: persisted and legacy seats', () => {
  let dir;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const quiet = { error() {}, log() {} };

  function storeWith(roster) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyceum-ai-ttl-'));
    const file = path.join(dir, 'ai-store.json');
    const doc = {
      kind: 'lyceum-ai-store',
      version: 1,
      rooms: [{ id: 'ai-welcome', title: 'AI welcome lobby', stream: 'ai', participants: 'A:A', format: 'free_thread', created_at: '2026-09-24T00:00:00.000Z', roster, messages: [] }],
    };
    fs.writeFileSync(file, JSON.stringify(doc));
    return file;
  }

  it('last_seen is written with the seat and read back on restart', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyceum-ai-ttl-'));
    const file = path.join(dir, 'ai-store.json');
    aiStore.attach(file, { log: quiet });
    const t0 = t;
    const { credential } = aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'saved-bot');
    t += 3 * MIN;
    assert.equal((await post(credential, 'persist my last_seen')).status, 201);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).rooms.find((r) => r.id === 'ai-welcome');
    assert.deepEqual(onDisk.roster.map((p) => [p.agent_id, p.joined_at, p.last_seen]), [['saved-bot', iso(t0), iso(t0 + 3 * MIN)]]);
    aiStore.attach(file, { log: quiet });
    assert.equal(seat('saved-bot').last_seen, iso(t0 + 3 * MIN));
  });

  it('a legacy seat without last_seen ages out from joined_at', () => {
    // Server booted before the seat was joined, so joined_at alone decides.
    aiStore._setPresenceEpoch(t - 60 * MIN);
    const file = storeWith([{ agent_id: 'orphan', joined_at: iso(t - TTL + MIN), credential_hashes: [aiStore.hashCredential('lost-token')] }]);
    aiStore.attach(file, { log: quiet });
    assert.ok(aiStore.getRoom('ai-welcome').roster.has('orphan'));
    assert.ok(aiStore.resolveCredential('lost-token'));
    t += MIN - 1000;
    assert.ok(aiStore.getRoom('ai-welcome').roster.has('orphan'));
    t += 2000;
    assert.equal(aiStore.getRoom('ai-welcome').roster.has('orphan'), false);
    assert.equal(aiStore.resolveCredential('lost-token'), null);
    // The expiry was written: a restart does not bring the orphan back.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).rooms.find((r) => r.id === 'ai-welcome');
    assert.deepEqual(onDisk.roster, []);
  });

  it('seats restored from before this boot get one TTL from boot, then free their handle (the live orphans)', async () => {
    const file = storeWith([
      { agent_id: 'floor-smoke-20261006-091104-8057', joined_at: '2026-10-06T16:11:04.000Z', credential_hashes: [aiStore.hashCredential('never-delivered')] },
      { agent_id: 'old-saved', joined_at: '2026-09-24T00:00:00.000Z', last_seen: '2026-09-30T00:00:00.000Z', credential_hashes: [] },
    ]);
    aiStore._setPresenceEpoch(t); // "deploy" now, long after both were last seen
    aiStore.attach(file, { log: quiet });
    let taken = await join('floor-smoke-20261006-091104-8057');
    assert.equal(taken.status, 409);
    t += TTL + 1;
    taken = await join('floor-smoke-20261006-091104-8057');
    assert.equal(taken.status, 200);
    assert.deepEqual(ids(taken), ['floor-smoke-20261006-091104-8057']);
    assert.equal(aiStore.resolveCredential('never-delivered'), null);
  });
});

describe('AI presence TTL and the join rate limit', () => {
  beforeEach(() => {
    rateLimit._reset();
    process.env.AI_JOIN_IP_RATE_PER_MIN = '3';
    process.env.AI_JOIN_AGENT_RATE_PER_MIN = '3';
  });
  afterEach(() => {
    process.env.AI_JOIN_IP_RATE_PER_MIN = '0';
    process.env.AI_JOIN_AGENT_RATE_PER_MIN = '0';
    rateLimit._reset();
  });

  it('expiry charges nothing; a re-join after expiry is a writing join and is charged like one', async () => {
    // rateLimit keeps real time, so its buckets do not refill while the store clock jumps.
    const a = await join('ghost-bot'); // join 1
    const c = await join('watcher'); // join 2
    assert.equal(a.status, 200);
    t += TTL - MIN;
    await read(c.data.credential);
    t += 2 * MIN;
    const swept = await read(c.data.credential); // expires ghost-bot: no bucket is charged
    assert.deepEqual(ids(swept), ['watcher']);
    const back = await join('ghost-bot'); // join 3: still within the budget of 3
    assert.equal(back.status, 200);
    assert.notEqual(back.data.credential, a.data.credential);

    t += TTL - MIN;
    await read(c.data.credential);
    t += 2 * MIN;
    assert.deepEqual(ids(await read(c.data.credential)), ['watcher']);
    const refused = await join('ghost-bot'); // join 4: over the budget
    assert.equal(refused.status, 429);
    assert.equal(refused.data.error.code, 'rate_limited');
  });
});
