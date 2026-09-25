/**
 * Open presence and turn hygiene: leave frees the turn, stale awaited ids self-heal,
 * idle parties expire after OPEN_PRESENCE_TTL_MS, heartbeat keeps a quiet party present.
 * Time is injected with openStore._setClock, so nothing sleeps.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('../src/openStore');
const notify = require('../src/notify');
const persist = require('../src/persist');

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

async function waitFor(check, ms = 1000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

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
    // 12 min: off the roster (expired at 10 min); still awaited for one TTL from its expiry.
    let read = await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    assert.deepEqual(read.data.roster.map((p) => `${p.party}:${p.id}`), ['human:jason']);
    assert.deepEqual(read.data.turn.awaiting, ['ghost-bot']);
    for (let i = 0; i < 3; i += 1) {
      t += 3 * MIN;
      await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    }
    // 21 min: more than one TTL after expiry (10 min) -> gone from awaiting, turn open.
    read = await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    assert.equal(read.data.turn.state, 'open');
    assert.deepEqual(read.data.turn.awaiting, []);

    const stale = await json('POST', `/api/open/rooms/${room}/post`, { body: 'late' }, { Authorization: `Bearer ${ghost.data.credential}` });
    assert.equal(stale.status, 401);

    // Everyone idles out: the room keeps its history instead of being deleted.
    t += TTL + MIN;
    assert.equal(openStore._openRooms.has(room), true);
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

describe('Handoff 7 fixes', () => {
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

  async function roomWith(...handles) {
    const id = (await json('POST', '/api/open/rooms', { title: 'H7' })).data.room_id;
    for (const h of handles) await json('POST', `/api/open/rooms/${id}/join`, { handle: h, party: 'human' });
    return id;
  }

  it('F1: an expired member keeps inbox unread and message notifications; an explicit leave ends both', async () => {
    const pushed = [];
    notify._setWebPushSender(async (push, body) => {
      pushed.push(JSON.parse(body));
      return { statusCode: 201 };
    });
    const room = await roomWith('qa-a', 'qa-c');
    const subscription = { endpoint: 'https://web.push.apple.com/cWEtYw', keys: { p256dh: 'BPk3yK0test', auth: 'authsecret' } };
    const sub = await json('POST', '/api/open/push/subscribe', { handle: 'qa-c', subscription, events: ['message'] });
    assert.equal(sub.status, 201);
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'news' });
    let inbox = await json('GET', '/api/open/inbox?handle=qa-c');
    assert.equal(inbox.data.items.length, 1);
    assert.equal(inbox.data.items[0].unread, 1);

    // qa-c goes quiet past the TTL while qa-a stays active.
    t += 6 * MIN;
    await json('POST', `/api/open/rooms/${room}/heartbeat`, { handle: 'qa-a' });
    t += 6 * MIN;
    const read = await json('GET', `/api/open/rooms/${room}/messages?handle=qa-a`);
    assert.deepEqual(read.data.roster.map((p) => p.id), ['qa-a']);
    const r = openStore._openRooms.get(room);
    assert.equal(openStore.isMember(r, 'human', 'qa-c'), true);

    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'more news' });
    inbox = await json('GET', '/api/open/inbox?handle=qa-c');
    assert.equal(inbox.data.items.length, 1);
    assert.equal(inbox.data.items[0].unread, 2);
    // `message` push still reaches the expired member (first post + this one).
    await waitFor(() => pushed.length === 2);
    assert.equal(pushed[1].body, 'more news');
    // Posting still requires joining again.
    assert.equal((await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-c', body: 'hi' })).status, 403);

    // An expired member may still leave explicitly; that ends membership.
    const left = await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'qa-c' });
    assert.equal(left.status, 200);
    assert.equal(openStore.isMember(r, 'human', 'qa-c'), false);
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'after leave' });
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(pushed.length, 2);
    inbox = await json('GET', '/api/open/inbox?handle=qa-c');
    assert.equal(inbox.data.items.length, 0);
    notify.clearAll();
  });

  it('F2: a human reply does not implicitly hand the turn to an AI that left or expired', async () => {
    const room = await roomWith('qa-a');
    const bot = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'leaver-bot', party: 'ai' });
    const auth = { Authorization: `Bearer ${bot.data.credential}` };
    await json('POST', `/api/open/rooms/${room}/post`, { body: 'bye all' }, auth);
    await json('POST', `/api/open/rooms/${room}/leave`, {}, auth);
    const thanks = await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'thanks, bye' });
    assert.equal(thanks.data.message.implicit_turn, undefined);
    assert.equal(thanks.data.message.awaiting, undefined);
    assert.equal(thanks.data.turn.state, 'open');

    // Expired instead of left.
    const bot2 = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'sleepy-bot', party: 'ai' });
    await json('POST', `/api/open/rooms/${room}/post`, { body: 'answer' }, { Authorization: `Bearer ${bot2.data.credential}` });
    t += 6 * MIN;
    await json('POST', `/api/open/rooms/${room}/heartbeat`, { handle: 'qa-a' });
    t += 6 * MIN;
    const late = await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'got it' });
    assert.equal(late.data.message.implicit_turn, undefined);
    assert.equal(late.data.turn.state, 'open');

    // Still hands off to an AI that is present.
    const bot3 = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'here-bot', party: 'ai' });
    await json('POST', `/api/open/rooms/${room}/post`, { body: 'hello' }, { Authorization: `Bearer ${bot3.data.credential}` });
    const reply = await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'hi' });
    assert.equal(reply.data.message.implicit_turn, true);
    assert.deepEqual(reply.data.turn.awaiting, ['here-bot']);
  });

  it('F3: an expiry done by a read schedules a snapshot; the revoked token stays revoked after restore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-open-h7-'));
    const prev = process.env.LYCEUM_DATA_DIR;
    process.env.LYCEUM_DATA_DIR = dir;
    try {
      const room = await roomWith('crash-h');
      const bot = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'crash-bot', party: 'ai' });
      const auth = { Authorization: `Bearer ${bot.data.credential}` };
      await new Promise((r) => setTimeout(r, 700)); // let the POST-triggered save land
      const file = persist.snapshotPath();
      assert.ok(fs.existsSync(file));
      fs.unlinkSync(file);

      t += 6 * MIN;
      await json('POST', `/api/open/rooms/${room}/heartbeat`, { handle: 'crash-h' });
      await new Promise((r) => setTimeout(r, 700));
      fs.unlinkSync(file);
      t += 6 * MIN;
      // Only GETs from here on: the read expires crash-bot.
      const read = await json('GET', `/api/open/rooms/${room}/messages?handle=crash-h`);
      assert.deepEqual(read.data.roster.map((p) => p.id), ['crash-h']);
      await new Promise((r) => setTimeout(r, 700));
      assert.ok(fs.existsSync(file), 'a GET that expired someone must schedule a save');

      // Simulate kill -9 + restart: restore the snapshot on disk.
      persist.restore(JSON.parse(fs.readFileSync(file, 'utf8')));
      assert.equal(openStore.resolveCredential(bot.data.credential), null);
      const zombie = await json('POST', `/api/open/rooms/${room}/post`, { body: 'zombie' }, auth);
      assert.equal(zombie.status, 401);
    } finally {
      if (prev === undefined) delete process.env.LYCEUM_DATA_DIR;
      else process.env.LYCEUM_DATA_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F4: OPEN_PRESENCE_TTL_MS accepts only whole numbers, clamps to 30 s, 0 is off; bad values warn', () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      for (const bad of [' ', 'abc', '-5', '10m', 'Infinity', '0x1388', '1.5e3', '5000.7', ' 60000', '1e30']) {
        process.env.OPEN_PRESENCE_TTL_MS = bad;
        assert.equal(openStore.presenceTtlMs(), TTL, `value ${JSON.stringify(bad)}`);
      }
      assert.equal(warnings.length, 10);
      process.env.OPEN_PRESENCE_TTL_MS = '1';
      assert.equal(openStore.presenceTtlMs(), 30000);
      assert.match(warnings[warnings.length - 1], /minimum/);
      process.env.OPEN_PRESENCE_TTL_MS = '45000';
      assert.equal(openStore.presenceTtlMs(), 45000);
      process.env.OPEN_PRESENCE_TTL_MS = '0';
      assert.equal(openStore.presenceTtlMs(), 0);
      assert.match(openStore.describePresenceTtl(), /off/);
      process.env.OPEN_PRESENCE_TTL_MS = '';
      assert.equal(openStore.presenceTtlMs(), TTL);
      delete process.env.OPEN_PRESENCE_TTL_MS;
      assert.equal(openStore.describePresenceTtl(), 'Open presence TTL: 600000 ms');
      assert.equal(warnings.length, 11);
    } finally {
      console.warn = orig;
    }
  });

  it('F6: leave by a non-member is refused without the roster; members and expired members may leave', async () => {
    const room = await roomWith('keeper', 'quiet');
    const stranger = await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'nobody-here' });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.data.error.code, 'not_joined');
    assert.equal(stranger.data.roster, undefined);
    assert.doesNotMatch(JSON.stringify(stranger.data), /last_seen/);

    t += 6 * MIN;
    await json('POST', `/api/open/rooms/${room}/heartbeat`, { handle: 'keeper' });
    t += 6 * MIN;
    await json('GET', `/api/open/rooms/${room}/messages?handle=keeper`); // quiet expires
    const expiredLeave = await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'quiet' });
    assert.equal(expiredLeave.status, 200);
    const again = await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'quiet' });
    assert.equal(again.status, 403);
  });

  it('F7: an absent awaited party lingers one TTL from max(handed, expired), not longer', async () => {
    const room = await roomWith('qa-a', 'qa-b');
    // qa-b idles 9 min, then is handed the turn; it expires at 10 min.
    t += 9 * MIN;
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'qa-b?', awaiting: ['qa-b'] });
    t += 2 * MIN; // 11 min
    let read = await json('GET', `/api/open/rooms/${room}/messages?handle=qa-a`);
    assert.deepEqual(read.data.roster.map((p) => p.id), ['qa-a']);
    assert.deepEqual(read.data.turn.awaiting, ['qa-b']);
    t += 8 * MIN + 30 * 1000; // 19.5 min: < expiry (10) + TTL
    read = await json('GET', `/api/open/rooms/${room}/messages?handle=qa-a`);
    assert.deepEqual(read.data.turn.awaiting, ['qa-b']);
    t += 60 * 1000; // 20.5 min: > expiry + TTL
    read = await json('GET', `/api/open/rooms/${room}/messages?handle=qa-a`);
    assert.deepEqual(read.data.turn.awaiting, []);
    assert.equal(read.data.turn.state, 'open');

    // Handed long after expiring (a wake): the grace runs from the hand.
    t += 30 * MIN;
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'qa-a', party: 'human' });
    const again = await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'again', awaiting: ['qa-b'] });
    assert.deepEqual(again.data.turn.awaiting, ['qa-b']);
    t += TTL - 1000;
    read = await json('GET', `/api/open/rooms/${room}/messages?handle=qa-a`);
    assert.deepEqual(read.data.turn.awaiting, ['qa-b']);
    t += 2000;
    read = await json('GET', `/api/open/rooms/${room}/messages?handle=qa-a`);
    assert.deepEqual(read.data.turn.awaiting, []);
  });

  it('F8: expiry alone keeps a room and its history; a refused leave deletes nothing', async () => {
    const room = await roomWith('qa-c');
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-c', body: 'history' });
    t += TTL + MIN;
    assert.ok(openStore.getRoom(room), 'expiry does not delete the room');
    assert.equal(openStore.getRoom(room).roster.size, 0);
    assert.equal(openStore.getRoom(room).messages.length, 1);
    const res = await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'someone-else' });
    assert.equal(res.status, 403);
    assert.equal(res.data.roster, undefined);
    assert.equal(openStore._openRooms.has(room), true);
    assert.equal(openStore.getRoom(room).messages.length, 1);
  });

  it('F10: GET messages trims the handle; restored entries show the boot time as last_seen', async () => {
    const room = await roomWith('qa-a');
    const read = await json('GET', `/api/open/rooms/${room}/messages?handle=${encodeURIComponent('  qa-a  ')}`);
    assert.equal(read.status, 200);
    const lobby = openStore._openRooms.get('open-welcome');
    lobby.roster.set('human:old', { id: 'old', party: 'human', joined_at: '2026-09-24T17:00:00.000Z' });
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'qa-a', party: 'human' });
    const lr = await json('GET', '/api/open/rooms/open-welcome/messages?handle=qa-a');
    const old = lr.data.roster.find((p) => p.id === 'old');
    assert.ok(Date.parse(old.last_seen) > Date.parse('2026-09-25T00:00:00.000Z'));
    assert.notEqual(old.last_seen, old.joined_at);
  });
});

describe('Handoff 7 recheck: room deletion (R1) and id case (R3)', () => {
  const TTL = openStore.DEFAULT_PRESENCE_TTL_MS;
  const MIN = 60 * 1000;
  let t;
  beforeEach(() => {
    t = Date.now();
    openStore._setClock(() => t);
  });
  afterEach(() => openStore._setClock());

  /** A room with the given members and one message, then everyone idles past the TTL. */
  async function expiredRoom(...handles) {
    const id = (await json('POST', '/api/open/rooms', { title: 'R1', visibility: 'unlisted' })).data.room_id;
    for (const h of handles) await json('POST', `/api/open/rooms/${id}/join`, { handle: h, party: 'human' });
    await json('POST', `/api/open/rooms/${id}/post`, { handle: handles[handles.length - 1], body: 'history 1' });
    t += TTL + MIN;
    assert.equal(openStore.getRoom(id).roster.size, 0);
    return id;
  }

  it("R1: a stranger's leave on an all-expired room is refused; the room and a kept member's inbox survive", async () => {
    const room = await expiredRoom('qa-z', 'qa-z2');
    const before = await json('GET', '/api/open/inbox?handle=qa-z');
    assert.equal(before.data.items.find((i) => i.room_id === room).unread, 1);
    for (const handle of ['stranger', 'made-up']) {
      const res = await json('POST', `/api/open/rooms/${room}/leave`, { handle });
      assert.equal(res.status, 403);
      assert.equal(res.data.error.code, 'not_joined');
      assert.equal(res.data.roster, undefined);
    }
    assert.equal(openStore._openRooms.has(room), true);
    assert.equal(openStore.getRoom(room).messages.length, 1);
    const after = await json('GET', '/api/open/inbox?handle=qa-z');
    assert.equal(after.data.items.find((i) => i.room_id === room).unread, 1);
    const rejoin = await json('POST', `/api/open/rooms/${room}/join`, { handle: 'qa-z', party: 'human' });
    assert.equal(rejoin.status, 200);
  });

  it('R1: an expired member leaving while another kept member remains does not delete the room', async () => {
    const room = await expiredRoom('qa-w1', 'qa-w2');
    const left = await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'qa-w2' });
    assert.equal(left.status, 200);
    assert.equal(openStore._openRooms.has(room), true);
    assert.equal(openStore.getRoom(room).messages.length, 1);
    const inbox = await json('GET', '/api/open/inbox?handle=qa-w1');
    assert.equal(inbox.data.items.length, 1);
    assert.equal(inbox.data.items[0].unread, 1);
    // The last present member leaving does not delete it either while a kept member remains.
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'qa-w3', party: 'human' });
    assert.equal((await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'qa-w3' })).status, 200);
    assert.equal(openStore._openRooms.has(room), true);
    const rejoin = await json('POST', `/api/open/rooms/${room}/join`, { handle: 'qa-w1', party: 'human' });
    assert.equal(rejoin.status, 200);
  });

  it('R1: the last kept member leaving deletes the room', async () => {
    const room = await expiredRoom('qa-l1', 'qa-l2');
    assert.equal((await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'qa-l1' })).status, 200);
    assert.equal(openStore._openRooms.has(room), true);
    assert.equal((await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'qa-l2' })).status, 200);
    assert.equal(openStore._openRooms.has(room), false);
    const gone = await json('POST', `/api/open/rooms/${room}/join`, { handle: 'qa-l2', party: 'human' });
    assert.equal(gone.status, 404);
  });

  it('R1: open-welcome is never deleted', async () => {
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'qa-o', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'qa-o', body: 'lobby history' });
    t += TTL + MIN;
    assert.equal((await json('POST', '/api/open/rooms/open-welcome/leave', { handle: 'stranger' })).status, 403);
    assert.equal(openStore._openRooms.has('open-welcome'), true);
    assert.equal((await json('POST', '/api/open/rooms/open-welcome/leave', { handle: 'qa-o' })).status, 200);
    assert.equal(openStore._openRooms.has('open-welcome'), true);
    assert.equal(openStore.getRoom('open-welcome').messages.length, 1);
  });

  it('R3: ids compare case-insensitively in turn logic; a hand to qa-bot clears when QA-BOT answers', async () => {
    const room = (await json('POST', '/api/open/rooms', { title: 'R3' })).data.room_id;
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'qa-a', party: 'human' });
    const lower = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'qa-bot', party: 'ai' });
    const upper = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'QA-BOT', party: 'ai' });
    const lowerAuth = { Authorization: `Bearer ${lower.data.credential}` };
    const upperAuth = { Authorization: `Bearer ${upper.data.credential}` };
    await json('POST', `/api/open/rooms/${room}/post`, { body: 'from qa-bot' }, lowerAuth);
    await json('POST', `/api/open/rooms/${room}/leave`, {}, lowerAuth);

    // Explicit hand to qa-bot while QA-BOT is present: QA-BOT is the addressee (same rule as
    // awaiting, prune, notifications and inbox), so its answer clears the turn.
    const hand = await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'qa-bot?', awaiting: ['qa-bot'] });
    assert.deepEqual(hand.data.turn.awaiting, ['qa-bot']);
    const inbox = await json('GET', '/api/open/inbox', undefined, upperAuth);
    assert.equal(inbox.data.items.find((i) => i.room_id === room).your_turn, true);
    const answer = await json('POST', `/api/open/rooms/${room}/post`, { body: 'here' }, upperAuth);
    assert.equal(answer.data.turn.state, 'open');
    assert.deepEqual(answer.data.turn.awaiting, []);

    // The implicit handoff uses the same comparison: after a post by qa-bot (now gone), a
    // plain reply is handed on because QA-BOT is present, and QA-BOT's answer clears it.
    const back = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'qa-bot', party: 'ai' });
    const backAuth = { Authorization: `Bearer ${back.data.credential}` };
    await json('POST', `/api/open/rooms/${room}/post`, { body: 'one more thing' }, backAuth);
    await json('POST', `/api/open/rooms/${room}/leave`, {}, backAuth);
    const reply = await json('POST', `/api/open/rooms/${room}/post`, { handle: 'qa-a', body: 'thanks' });
    assert.equal(reply.data.message.implicit_turn, true);
    const again = await json('POST', `/api/open/rooms/${room}/post`, { body: 'ok' }, upperAuth);
    assert.deepEqual(again.data.turn.awaiting, []);
    assert.equal(again.data.turn.state, 'open');
  });
});
