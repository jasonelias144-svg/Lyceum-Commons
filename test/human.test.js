/**
 * Human API tests — welcome lobby, verbs, refuse AI parties on Human stream.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

let app;
let server;
let base;

before(async () => {
  app = require('../src/server');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store.clearAll();
});

async function json(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('pages', () => {
  it('serves / /human /ai /open', async () => {
    for (const p of ['/', '/human', '/ai', '/open', '/docs/protocol']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /Lyceum Commons/);
    }
  });

  it('home has three peer doors, locked welcome line, not a chat-with-AI CTA', async () => {
    const text = await (await fetch(`${base}/`)).text();
    assert.match(text, />Human</);
    assert.match(text, />AI</);
    assert.match(text, />Open</);
    assert.match(
      text,
      /Welcome to Lyceum Commons\. Human, AI, and Open are peer doors — choose one when you.re ready\./
    );
    assert.match(text, /class="face"/);
    assert.match(text, /class="atrium"/);
    // Human door arrives at welcome lobby; AI/Open stay stubs
    assert.match(text, /href=["']\/human\?room=welcome["']/);
    assert.match(text, /href=["']\/ai["']/);
    assert.match(text, /href=["']\/open["']/);
    assert.doesNotMatch(text, /guest book|guestbook|topic shelf/i);
    assert.doesNotMatch(text, /href=["'][^"']*["'][^>]*>\s*chat with AI/i);
    assert.doesNotMatch(text, /Start chatting/i);
    assert.doesNotMatch(text, /enter with an AI/i);
  });

  it('home Human door is welcome path; no under-grid CTA; /human keeps lobby CTA', async () => {
    const home = await (await fetch(`${base}/`)).text();
    // Human door alone is the welcome path — no solid under-grid primacy CTA
    assert.match(home, /href=["']\/human\?room=welcome["']/);
    assert.match(home, /data-room=["']human["']/);
    assert.match(home, /Enter welcome lobby/);
    assert.doesNotMatch(home, /class=["'][^"']*btn-cta/);
    assert.doesNotMatch(home, /class=["'][^"']*face-arrive/);
    // peers stay equal — AI/Open present, no guestbook / topic shelf
    assert.match(home, /data-room=["']ai["']/);
    assert.match(home, /data-room=["']open["']/);

    const human = await (await fetch(`${base}/human`)).text();
    assert.match(human, /Enter welcome lobby/);
    assert.match(human, /id="btn-welcome"/);
    assert.match(human, /Welcome lobby/);
    assert.match(human, /hotel or conference-center lobby/);
    // create is secondary
    assert.match(human, /id="btn-create"[^>]*class="secondary"|class="secondary"[^>]*id="btn-create"/);
  });

  it('ai and open stubs have no composer', async () => {
    const ai = await (await fetch(`${base}/ai`)).text();
    const open = await (await fetch(`${base}/open`)).text();
    assert.match(ai, /Not open for join yet/);
    assert.doesNotMatch(ai, /<textarea/);
    assert.match(open, /Needs both streams first/);
    assert.doesNotMatch(open, /<textarea/);
    assert.doesNotMatch(open, /id="btn-join"/);
  });
});

describe('Welcome lobby', () => {
  it('exists after boot with fixed id welcome', async () => {
    const room = store.getRoom(store.WELCOME_ROOM_ID);
    assert.ok(room);
    assert.equal(room.id, 'welcome');
    assert.equal(room.stream, 'human');
    assert.equal(room.participants, 'H:H');
    // empty: no fake chatter
    assert.equal(room.messages.length, 0);
    assert.equal(room.roster.size, 0);

    const list = await json('GET', '/api/human/rooms/welcome/messages');
    assert.equal(list.status, 200);
    assert.equal(list.data.room_id, 'welcome');
    assert.equal(list.data.messages.length, 0);
  });

  it('join → post → list → leave on welcome', async () => {
    const join = await json('POST', '/api/human/rooms/welcome/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(join.status, 200);
    assert.equal(join.data.room_id, 'welcome');
    assert.equal(join.data.roster.length, 1);

    const post = await json('POST', '/api/human/rooms/welcome/post', {
      handle: 'Ada',
      body: 'Arrived in the lobby.',
      party: 'human',
    });
    assert.equal(post.status, 201);
    assert.equal(post.data.message.author, 'Ada');
    assert.equal(post.data.message.party, 'human');

    const list = await json('GET', '/api/human/rooms/welcome/messages');
    assert.equal(list.status, 200);
    assert.equal(list.data.messages.length, 1);
    assert.equal(list.data.roster.length, 1);

    const leave = await json('POST', '/api/human/rooms/welcome/leave', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(leave.status, 200);
    assert.equal(leave.data.ok, true);
    assert.equal(leave.data.roster.length, 0);
  });

  it('refuses AI on welcome lobby', async () => {
    const res = await json('POST', '/api/human/rooms/welcome/join', {
      handle: 'Bot',
      party: 'ai',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_human');
  });

  it('survives clearAll (re-seeded)', () => {
    store.clearAll();
    const room = store.getRoom('welcome');
    assert.ok(room);
    assert.equal(room.id, 'welcome');
  });
});

describe('Human verbs', () => {
  it('create → join → post → list → leave', async () => {
    const created = await json('POST', '/api/human/rooms', {});
    assert.equal(created.status, 201);
    assert.ok(created.data.room_id);
    assert.equal(created.data.stream, 'human');

    const roomId = created.data.room_id;

    const join = await json('POST', `/api/human/rooms/${roomId}/join`, {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(join.status, 200);
    assert.equal(join.data.roster.length, 1);
    assert.equal(join.data.roster[0].handle, 'Ada');

    // idempotent re-join
    const rejoin = await json('POST', `/api/human/rooms/${roomId}/join`, {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(rejoin.status, 200);
    assert.equal(rejoin.data.roster.length, 1);

    const post = await json('POST', `/api/human/rooms/${roomId}/post`, {
      handle: 'Ada',
      body: 'Hello from the Human room.',
      party: 'human',
    });
    assert.equal(post.status, 201);
    assert.equal(post.data.message.party, 'human');
    assert.equal(post.data.message.author, 'Ada');

    const list = await json('GET', `/api/human/rooms/${roomId}/messages`);
    assert.equal(list.status, 200);
    assert.equal(list.data.messages.length, 1);
    assert.equal(list.data.roster.length, 1);

    const leave = await json('POST', `/api/human/rooms/${roomId}/leave`, {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(leave.status, 200);
    assert.equal(leave.data.ok, true);
    assert.equal(leave.data.roster.length, 0);

    // leave if absent: no-op
    const leave2 = await json('POST', `/api/human/rooms/${roomId}/leave`, {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(leave2.status, 200);
  });

  it('second human can join and see thread', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const id = created.room_id;
    await json('POST', `/api/human/rooms/${id}/join`, { handle: 'Ada', party: 'human' });
    await json('POST', `/api/human/rooms/${id}/post`, {
      handle: 'Ada',
      body: 'First',
      party: 'human',
    });
    await json('POST', `/api/human/rooms/${id}/join`, { handle: 'Bea', party: 'human' });
    const list = await json('GET', `/api/human/rooms/${id}/messages`);
    assert.equal(list.data.roster.length, 2);
    assert.equal(list.data.messages.length, 1);
  });

  it('rejects post when not joined', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const res = await json('POST', `/api/human/rooms/${created.room_id}/post`, {
      handle: 'Ghost',
      body: 'nope',
      party: 'human',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_joined');
  });

  it('rejects unknown room', async () => {
    const res = await json('POST', '/api/human/rooms/hrm_missing/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, 'room_not_found');
  });

  it('rejects invalid handle and body', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const id = created.room_id;
    const badHandle = await json('POST', `/api/human/rooms/${id}/join`, {
      handle: '',
      party: 'human',
    });
    assert.equal(badHandle.data.error.code, 'invalid_handle');

    await json('POST', `/api/human/rooms/${id}/join`, { handle: 'Ada', party: 'human' });
    const badBody = await json('POST', `/api/human/rooms/${id}/post`, {
      handle: 'Ada',
      body: '',
      party: 'human',
    });
    assert.equal(badBody.data.error.code, 'invalid_body');
  });

  it('enforces soft room_full cap', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const id = created.room_id;
    for (let i = 0; i < 16; i++) {
      const r = await json('POST', `/api/human/rooms/${id}/join`, {
        handle: `H${i}`,
        party: 'human',
      });
      assert.equal(r.status, 200);
    }
    const full = await json('POST', `/api/human/rooms/${id}/join`, {
      handle: 'Overflow',
      party: 'human',
    });
    assert.equal(full.status, 403);
    assert.equal(full.data.error.code, 'room_full');
  });
});

describe('Refuse AI on Human API', () => {
  it('join with party ai → 403 not_human', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const res = await json('POST', `/api/human/rooms/${created.room_id}/join`, {
      handle: 'Bot',
      party: 'ai',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_human');
  });

  it('join with party machine → 403 not_human', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const res = await json('POST', `/api/human/rooms/${created.room_id}/join`, {
      handle: 'Bot',
      party: 'machine',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_human');
  });

  it('create with party ai → 403 not_human', async () => {
    const res = await json('POST', '/api/human/rooms', { party: 'ai' });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_human');
  });

  it('post with party ai → 403 not_human', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    await json('POST', `/api/human/rooms/${created.room_id}/join`, {
      handle: 'Ada',
      party: 'human',
    });
    const res = await json('POST', `/api/human/rooms/${created.room_id}/post`, {
      handle: 'Ada',
      body: 'sneaky',
      party: 'ai',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_human');
  });

  it('/api/ai is not implemented', async () => {
    const res = await json('GET', '/api/ai/rooms');
    assert.equal(res.status, 501);
  });
});
