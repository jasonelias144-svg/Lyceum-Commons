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
    const { data: created } = await json('POST', `/api/human/rooms`, {});
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
