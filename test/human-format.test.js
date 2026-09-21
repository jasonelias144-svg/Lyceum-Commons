/**
 * Human room format — live | board physics (body caps, defaults, inherit).
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

describe('Room format live|board', () => {
  it('welcome defaults to live; topics and private create to board', async () => {
    const welcome = store.getRoom('welcome');
    assert.equal(welcome.format, 'live');

    for (const seed of store.TOPIC_SEEDS) {
      assert.equal(store.getRoom(seed.id).format, 'board');
    }

    const created = await json('POST', '/api/human/rooms', {});
    assert.equal(created.status, 201);
    assert.equal(created.data.format, 'board');
    assert.equal(store.getRoom(created.data.room_id).format, 'board');
  });

  it('exposes format on roomMeta (join/list) and GET /topics', async () => {
    const join = await json('POST', '/api/human/rooms/welcome/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(join.status, 200);
    assert.equal(join.data.format, 'live');

    const list = await json('GET', '/api/human/rooms/welcome/messages');
    assert.equal(list.status, 200);
    assert.equal(list.data.format, 'live');

    const topics = await json('GET', '/api/human/topics');
    assert.equal(topics.status, 200);
    assert.ok(topics.data.topics.length >= 12);
    for (const t of topics.data.topics) {
      assert.equal(t.format, 'board');
    }

    const topicJoin = await json('POST', '/api/human/rooms/topic-protocols/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(topicJoin.data.format, 'board');
  });

  it('welcome live: 200 OK; 201+ → invalid_body naming live', async () => {
    await json('POST', '/api/human/rooms/welcome/join', {
      handle: 'Ada',
      party: 'human',
    });

    const ok = await json('POST', '/api/human/rooms/welcome/post', {
      handle: 'Ada',
      body: 'x'.repeat(200),
      party: 'human',
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.message.body.length, 200);

    const over = await json('POST', '/api/human/rooms/welcome/post', {
      handle: 'Ada',
      body: 'x'.repeat(201),
      party: 'human',
    });
    assert.equal(over.status, 400);
    assert.equal(over.data.error.code, 'invalid_body');
    assert.match(over.data.error.message, /Live rooms take up to 200/i);
  });

  it('topic board still allows 4000; 4001 → invalid_body naming board', async () => {
    const roomId = 'topic-naming';
    await json('POST', `/api/human/rooms/${roomId}/join`, {
      handle: 'Pat',
      party: 'human',
    });

    const ok = await json('POST', `/api/human/rooms/${roomId}/post`, {
      handle: 'Pat',
      body: 'y'.repeat(4000),
      party: 'human',
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.message.body.length, 4000);

    const over = await json('POST', `/api/human/rooms/${roomId}/post`, {
      handle: 'Pat',
      body: 'y'.repeat(4001),
      party: 'human',
    });
    assert.equal(over.status, 400);
    assert.equal(over.data.error.code, 'invalid_body');
    assert.match(over.data.error.message, /Board rooms take up to 4000/i);
  });

  it('branch inherits parent format (welcome → live child)', async () => {
    await json('POST', '/api/human/rooms/welcome/join', {
      handle: 'Ada',
      party: 'human',
    });
    const branch = await json('POST', '/api/human/rooms/welcome/branch', {
      handle: 'Ada',
      party: 'human',
      title: 'Side pulse',
    });
    assert.equal(branch.status, 201);
    assert.equal(branch.data.format, 'live');
    assert.equal(branch.data.parent_id, 'welcome');
    assert.equal(store.getRoom(branch.data.room_id).format, 'live');

    // Child still under live cap
    const over = await json('POST', `/api/human/rooms/${branch.data.room_id}/post`, {
      handle: 'Ada',
      body: 'z'.repeat(201),
      party: 'human',
    });
    assert.equal(over.status, 400);
    assert.equal(over.data.error.code, 'invalid_body');
    assert.match(over.data.error.message, /Live rooms take up to 200/i);
  });

  it('branch from board topic stays board', async () => {
    const parentId = 'topic-building';
    await json('POST', `/api/human/rooms/${parentId}/join`, {
      handle: 'Sam',
      party: 'human',
    });
    const branch = await json('POST', `/api/human/rooms/${parentId}/branch`, {
      handle: 'Sam',
      party: 'human',
    });
    assert.equal(branch.data.format, 'board');
    assert.equal(branch.status, 201);
  });

  it('/human UI carries format chrome (counter + data-format)', async () => {
    const html = await (await fetch(`${base}/human`)).text();
    assert.match(html, /id="body-count"/);
    assert.match(html, /id="format-display"/);
    assert.match(html, /data-format="board"/);
    const js = await (await fetch(`${base}/js/human.js`)).text();
    assert.match(js, /CAP_LIVE/);
    assert.match(js, /applyFormatFace/);
    assert.match(js, /Live ticker/);
  });
});
