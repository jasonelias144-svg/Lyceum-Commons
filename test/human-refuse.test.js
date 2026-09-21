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
