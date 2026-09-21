/**
 * Topic shelf format asserts (supplement to human-topics.test.js).
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

describe('Topic shelf format', () => {
  it('seeds and GET /topics expose format board', async () => {
    for (const seed of store.TOPIC_SEEDS) {
      assert.equal(store.getRoom(seed.id).format, 'board');
    }
    const res = await fetch(`${base}/api/human/topics`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    for (const t of data.topics) {
      assert.equal(t.format, 'board');
    }
  });
});
