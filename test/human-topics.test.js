/**
 * Human topic shelf — 12 roots, Host orientation, branch + thin merge.
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

describe('Topic shelf', () => {
  it('seeds ~12 root topics with empty roster + one Host message each', () => {
    assert.ok(store.TOPIC_SEEDS.length >= 12);
    const ids = new Set();
    for (const seed of store.TOPIC_SEEDS) {
      assert.ok(seed.id.startsWith('topic-'));
      assert.ok(seed.title);
      assert.equal(ids.has(seed.id), false, `duplicate id ${seed.id}`);
      ids.add(seed.id);
      const room = store.getRoom(seed.id);
      assert.ok(room);
      assert.equal(room.stream, 'human');
      assert.equal(room.participants, 'H:H');
      assert.equal(room.parent_id, null);
      assert.equal(room.merged_into, null);
      assert.equal(room.roster.size, 0);
      assert.equal(room.messages.length, 1);
      assert.equal(room.messages[0].author, 'Host');
      assert.match(room.messages[0].body, /Opening questions:/);
    }
    const welcome = store.getRoom('welcome');
    assert.ok(welcome);
    assert.equal(welcome.messages.length, 0);
    assert.equal(welcome.merged_into, null);
  });

  it('GET /api/human/topics lists roots, excludes welcome', async () => {
    const res = await json('GET', '/api/human/topics');
    assert.equal(res.status, 200);
    assert.equal(res.data.topics.length, store.TOPIC_SEEDS.length);
    const ids = res.data.topics.map((t) => t.id);
    assert.deepEqual(
      ids,
      store.TOPIC_SEEDS.map((s) => s.id)
    );
    for (const t of res.data.topics) {
      assert.equal(t.roster_count, 0);
      assert.equal(t.message_count, 1);
      assert.equal(t.parent_id, null);
      assert.equal(t.merged_into, null);
      assert.notEqual(t.id, 'welcome');
    }
  });

  it('join → post on a topic room works beside Host orientation', async () => {
    const roomId = 'topic-protocols';
    const join = await json('POST', `/api/human/rooms/${roomId}/join`, {
      handle: 'Pat',
      party: 'human',
    });
    assert.equal(join.status, 200);
    assert.equal(join.data.roster.length, 1);

    const post = await json('POST', `/api/human/rooms/${roomId}/post`, {
      handle: 'Pat',
      body: 'How do we name the door?',
      party: 'human',
    });
    assert.equal(post.status, 201);

    const list = await json('GET', `/api/human/rooms/${roomId}/messages`);
    assert.equal(list.status, 200);
    assert.equal(list.data.messages.length, 2);
    assert.equal(list.data.messages[0].author, 'Host');
    assert.equal(list.data.messages[1].author, 'Pat');
    assert.equal(list.data.roster.length, 1);
  });

  it('branch creates child with parent_id and Host lineage line', async () => {
    const parentId = 'topic-naming';
    await json('POST', `/api/human/rooms/${parentId}/join`, {
      handle: 'Ada',
      party: 'human',
    });
    const branch = await json('POST', `/api/human/rooms/${parentId}/branch`, {
      handle: 'Ada',
      party: 'human',
      title: 'Naming — proper nouns',
    });
    assert.equal(branch.status, 201);
    assert.equal(branch.data.parent_id, parentId);
    assert.equal(branch.data.title, 'Naming — proper nouns');
    assert.equal(branch.data.roster.length, 1);
    assert.equal(branch.data.merged_into, null);

    const child = store.getRoom(branch.data.room_id);
    assert.ok(child);
    assert.equal(child.parent_id, parentId);
    assert.equal(child.messages.length, 1);
    assert.equal(child.messages[0].author, 'Host');
    assert.match(child.messages[0].body, /Branched from/);

    // Topics list still only roots
    const topics = await json('GET', '/api/human/topics');
    assert.equal(topics.data.topics.length, store.TOPIC_SEEDS.length);
    assert.equal(
      topics.data.topics.some((t) => t.id === branch.data.room_id),
      false
    );
  });

  it('thin merge moves messages and sets merged_into', async () => {
    const a = await json('POST', '/api/human/rooms', {});
    const b = await json('POST', '/api/human/rooms', {});
    const sourceId = a.data.room_id;
    const targetId = b.data.room_id;

    await json('POST', `/api/human/rooms/${sourceId}/join`, {
      handle: 'Sam',
      party: 'human',
    });
    await json('POST', `/api/human/rooms/${targetId}/join`, {
      handle: 'Sam',
      party: 'human',
    });
    await json('POST', `/api/human/rooms/${sourceId}/post`, {
      handle: 'Sam',
      body: 'Duplicate thread note',
      party: 'human',
    });

    const merge = await json('POST', `/api/human/rooms/${sourceId}/merge`, {
      handle: 'Sam',
      party: 'human',
      target_id: targetId,
    });
    assert.equal(merge.status, 200);
    assert.equal(merge.data.ok, true);
    assert.ok(merge.data.moved >= 1);
    assert.equal(merge.data.source.merged_into, targetId);
    assert.equal(merge.data.target.room_id, targetId);

    const source = store.getRoom(sourceId);
    assert.equal(source.merged_into, targetId);
    assert.equal(source.roster.size, 0);

    const target = store.getRoom(targetId);
    assert.ok(target.messages.some((m) => /Duplicate thread note/.test(m.body)));
    assert.ok(target.merge_history.length >= 1);

    const rejoin = await json('POST', `/api/human/rooms/${sourceId}/join`, {
      handle: 'Sam',
      party: 'human',
    });
    assert.equal(rejoin.status, 409);
    assert.equal(rejoin.data.error.code, 'room_merged');
  });

  it('refuses merging welcome; re-seeds after clearAll', async () => {
    const bad = await json('POST', '/api/human/rooms/welcome/merge', {
      handle: 'Sam',
      party: 'human',
      target_id: 'topic-building',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'cannot_merge_welcome');

    store.clearAll();
    assert.equal(store.TOPIC_SEEDS.length, store.listTopics().length);
    for (const seed of store.TOPIC_SEEDS) {
      const room = store.getRoom(seed.id);
      assert.ok(room);
      assert.equal(room.messages[0].author, 'Host');
      assert.equal(room.merged_into, null);
    }
    assert.equal(store.getRoom('welcome').messages.length, 0);
  });

  it('/human has topic shelf; home does not', async () => {
    const human = await (await fetch(`${base}/human`)).text();
    assert.match(human, /Topic rooms/);
    assert.match(human, /Field of Dreams/);
    assert.match(human, /id="topic-shelf"/);
    assert.match(human, /Branch from this discussion/);
    assert.match(human, /btn-merge/);
    assert.doesNotMatch(human, /Named topic rooms come later/);

    const home = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(home, /topic shelf/i);
    assert.doesNotMatch(home, /id=["']topic-shelf["']/);
    assert.doesNotMatch(home, /Field of Dreams/);
  });
});
