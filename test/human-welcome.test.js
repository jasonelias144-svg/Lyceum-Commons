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
