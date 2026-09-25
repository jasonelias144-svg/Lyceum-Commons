/**
 * Open presence and turn hygiene: leave frees the turn, stale awaited ids self-heal,
 * idle parties expire after OPEN_PRESENCE_TTL_MS, heartbeat keeps a quiet party present.
 * Time is injected with openStore._setClock, so nothing sleeps.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const openStore = require('../src/openStore');

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
});

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('Leave frees the turn', () => {
  it('leaving drops the handle from turn.awaiting; the last awaited leaving reopens the turn', async () => {
    const room = (await json('POST', '/api/open/rooms', { title: 'Leavers' })).data.room_id;
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'jason', party: 'human' });
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'qc-tester', party: 'human' });
    const ai = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'claude-x', party: 'ai' });
    const post = await json('POST', `/api/open/rooms/${room}/post`, {
      handle: 'jason',
      body: 'Both of you, please.',
      awaiting: ['qc-tester', 'claude-x'],
    });
    assert.equal(post.data.turn.state, 'input-required');
    assert.deepEqual(post.data.turn.awaiting, ['qc-tester', 'claude-x']);

    const left = await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'qc-tester' });
    assert.equal(left.status, 200);
    assert.equal(left.data.turn.state, 'input-required');
    assert.deepEqual(left.data.turn.awaiting, ['claude-x']);

    const aiLeft = await json('POST', `/api/open/rooms/${room}/leave`, {}, { Authorization: `Bearer ${ai.data.credential}` });
    assert.equal(aiLeft.status, 200);
    assert.equal(aiLeft.data.turn.state, 'open');
    assert.deepEqual(aiLeft.data.turn.awaiting, []);

    const read = await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    assert.equal(read.data.turn.state, 'open');
    assert.deepEqual(read.data.roster.map((p) => p.id), ['jason']);
  });

  it('a leaver who shares an id with someone still present stays awaited', async () => {
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'nova', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/join', { agent_id: 'nova', party: 'ai' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'Nova?', awaiting: ['nova'] });
    const left = await json('POST', '/api/open/rooms/open-welcome/leave', { handle: 'nova' });
    assert.equal(left.data.turn.state, 'input-required');
    assert.deepEqual(left.data.turn.awaiting, ['nova']);
  });
});

describe('Awaiting self-heals', () => {
  afterEach(() => openStore._setClock());

  it('stale awaited ids that are not on the roster are pruned on read (the stuck lobby case)', async () => {
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    const lobby = openStore._openRooms.get('open-welcome');
    // As restored from a snapshot: two QC handles left long ago but are still awaited.
    lobby.turn = {
      state: 'input-required',
      awaiting: ['render-check-m1', 'qc-tester-h5'],
      note: null,
      updated_at: '2026-09-24T18:33:00.080Z',
      updated_by: 'grok-jason',
    };
    const read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.equal(read.data.turn.state, 'open');
    assert.deepEqual(read.data.turn.awaiting, []);
    const inbox = await json('GET', '/api/open/inbox?handle=qc-tester-h5');
    assert.equal(inbox.data.items.length, 0);
  });

  it('members stay awaited; a non-member handed the turn gets one TTL to arrive', async () => {
    let t = Date.now();
    openStore._setClock(() => t);
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    const post = await json('POST', '/api/open/rooms/open-welcome/post', {
      handle: 'jason',
      body: 'Grok, when you wake up.',
      awaiting: ['grok-jason'],
    });
    assert.deepEqual(post.data.turn.awaiting, ['grok-jason']);
    t += openStore.DEFAULT_PRESENCE_TTL_MS - 1000;
    let read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.deepEqual(read.data.turn.awaiting, ['grok-jason']);
    assert.equal(read.data.turn.state, 'input-required');
    t += 2000;
    read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.deepEqual(read.data.turn.awaiting, []);
    assert.equal(read.data.turn.state, 'open');
  });
});

describe('Presence TTL', () => {
  const TTL = openStore.DEFAULT_PRESENCE_TTL_MS;
  const MIN = 60 * 1000;
  let t;
  beforeEach(() => {
    t = Date.now();
    openStore._setClock(() => t);
  });
  afterEach(() => {
    openStore._setClock();
    delete process.env.OPEN_PRESENCE_TTL_MS;
  });

  it('defaults to 10 minutes', () => {
    assert.equal(TTL, 10 * MIN);
    assert.equal(openStore.presenceTtlMs(), 10 * MIN);
  });

  it('an idle ghost expires from the roster and from awaiting; its credential is revoked; the room survives', async () => {
    const room = (await json('POST', '/api/open/rooms', { title: 'Ghosts' })).data.room_id;
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'jason', party: 'human' });
    const ghost = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'ghost-bot', party: 'ai' });
    const post = await json('POST', `/api/open/rooms/${room}/post`, {
      handle: 'jason',
      body: 'Your turn, ghost.',
      awaiting: ['ghost-bot'],
    });
    assert.equal(post.data.turn.state, 'input-required');

    // jason keeps reading; ghost-bot's client was killed and never calls again.
    for (let i = 0; i < 4; i += 1) {
      t += 3 * MIN;
      await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    }
    const read = await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    assert.deepEqual(read.data.roster.map((p) => `${p.party}:${p.id}`), ['human:jason']);
    assert.equal(read.data.turn.state, 'open');
    assert.deepEqual(read.data.turn.awaiting, []);

    const stale = await json('POST', `/api/open/rooms/${room}/post`, { body: 'late' }, { Authorization: `Bearer ${ghost.data.credential}` });
    assert.equal(stale.status, 401);

    // Everyone idles out: the room keeps its history instead of being deleted.
    t += TTL + MIN;
    assert.ok(openStore.getRoom(room));
    assert.equal(openStore.getRoom(room).roster.size, 0);
    assert.equal(openStore.getRoom(room).messages.length, 1);
    const back = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'ghost-bot', party: 'ai' });
    assert.equal(back.status, 200);
    assert.notEqual(back.data.credential, ghost.data.credential);
  });

  it('an expired human must join again', async () => {
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    t += TTL + 1;
    const read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.equal(read.status, 403);
    assert.equal(read.data.error.code, 'not_joined');
    const post = await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'hi' });
    assert.equal(post.status, 403);
    const again = await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.data.roster.map((p) => p.id), ['jason']);
  });

  it('join, post, reading messages and other authenticated calls refresh last_seen', async () => {
    const t0 = t;
    const hj = await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    assert.equal(hj.data.roster[0].last_seen, new Date(t0).toISOString());
    const ai = await json('POST', '/api/open/rooms/open-welcome/join', { agent_id: 'claude-x', party: 'ai' });
    const auth = { Authorization: `Bearer ${ai.data.credential}` };

    t += 8 * MIN;
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'still here' });
    await json('GET', '/api/open/rooms/open-welcome/messages', undefined, auth);
    t += 8 * MIN; // 16 min after joining, 8 since last activity
    let read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.equal(read.status, 200);
    const byId = Object.fromEntries(read.data.roster.map((p) => [p.id, p]));
    assert.equal(byId['claude-x'].last_seen, new Date(t0 + 8 * MIN).toISOString());
    assert.equal(byId.jason.last_seen, new Date(t0 + 16 * MIN).toISOString());

    // AI inbox (authenticated) and human state change count as activity too.
    t += 1 * MIN; // claude-x idle 9 min
    const inbox = await json('GET', '/api/open/inbox', undefined, auth);
    assert.equal(inbox.status, 200);
    await json('POST', '/api/open/rooms/open-welcome/state', { handle: 'jason', state: 'open' });
    t += 9 * MIN; // both idle 9 min since those calls
    read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.deepEqual(read.data.roster.map((p) => p.id).sort(), ['claude-x', 'jason']);

    // Re-joining refreshes as well (claude-x last active at the inbox call, jason at the read).
    t += MIN / 2; // claude-x idle 9.5 min
    const rejoin = await json('POST', '/api/open/rooms/open-welcome/join', { agent_id: 'claude-x', party: 'ai' });
    assert.equal(rejoin.data.credential, ai.data.credential);
    t += 9.9 * MIN; // claude-x idle 9.9 min, jason 10.4 min

    read = await json('GET', '/api/open/rooms/open-welcome/messages', undefined, auth);
    assert.equal(read.status, 200);
    assert.deepEqual(read.data.roster.map((p) => p.id), ['claude-x']);
  });

  it('heartbeat keeps a quiet participant present (human and ai); strangers and cross-pose are refused', async () => {
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    const ai = await json('POST', '/api/open/rooms/open-welcome/join', { agent_id: 'claude-x', party: 'ai' });
    const auth = { Authorization: `Bearer ${ai.data.credential}` };
    for (let i = 0; i < 3; i += 1) {
      t += 6 * MIN;
      const h = await json('POST', '/api/open/rooms/open-welcome/heartbeat', { handle: 'jason' });
      assert.equal(h.status, 200);
      assert.equal(h.data.ok, true);
      assert.equal(h.data.presence_ttl_ms, TTL);
      assert.equal(h.data.room_id, 'open-welcome');
      assert.ok(h.data.turn);
      const a = await json('POST', '/api/open/rooms/open-welcome/heartbeat', {}, auth);
      assert.equal(a.status, 200);
      assert.deepEqual(a.data.roster.map((p) => `${p.party}:${p.id}`).sort(), ['ai:claude-x', 'human:jason']);
    }
    const stranger = await json('POST', '/api/open/rooms/open-welcome/heartbeat', { handle: 'nobody' });
    assert.equal(stranger.status, 403);
    const pose = await json('POST', '/api/open/rooms/open-welcome/heartbeat', { handle: 'jason' }, auth);
    assert.equal(pose.status, 403);
    const pose2 = await json('POST', '/api/open/rooms/open-welcome/heartbeat', { handle: 'jason', party: 'ai' });
    assert.equal(pose2.status, 403);
    const noRoom = await json('POST', '/api/open/rooms/orm_missing/heartbeat', { handle: 'jason' });
    assert.equal(noRoom.status, 404);
  });

  it('OPEN_PRESENCE_TTL_MS configures the TTL; 0 turns expiry off', async () => {
    process.env.OPEN_PRESENCE_TTL_MS = String(MIN);
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'quiet', party: 'human' });
    t += 50 * 1000;
    await json('POST', '/api/open/rooms/open-welcome/heartbeat', { handle: 'jason' });
    t += 20 * 1000;
    let read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.deepEqual(read.data.roster.map((p) => p.id), ['jason']);

    process.env.OPEN_PRESENCE_TTL_MS = '0';
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'quiet', party: 'human' });
    t += 24 * 60 * MIN;
    read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.deepEqual(read.data.roster.map((p) => p.id).sort(), ['jason', 'quiet']);
  });

  it('entries restored without last_seen get one TTL from boot, then expire (the live lobby ghosts)', async () => {
    const lobby = openStore._openRooms.get('open-welcome');
    lobby.roster.set('human:old-ghost', { id: 'old-ghost', party: 'human', joined_at: '2026-09-24T17:00:00.000Z' });
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    let read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.deepEqual(read.data.roster.map((p) => p.id).sort(), ['jason', 'old-ghost']);
    t += TTL + 1;
    await json('POST', '/api/open/rooms/open-welcome/heartbeat', { handle: 'jason' });
    // jason's heartbeat came too late as well; he rejoins and the ghost is gone.
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    read = await json('GET', '/api/open/rooms/open-welcome/messages?handle=jason');
    assert.deepEqual(read.data.roster.map((p) => p.id), ['jason']);
  });
});
