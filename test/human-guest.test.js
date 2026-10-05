/**
 * Human guest identity — the #41 Open rules, mirrored for /api/human (shared logic in
 * src/guestIdentity.js, Human data in src/store.js). Every call here sets its own
 * X-Lyceum-Guest header (or none); nothing goes through the test key jar.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../src/store');
const openStore = require('../src/openStore');
const persist = require('../src/persist');
const guestIdentity = require('../src/guestIdentity');

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
  store.clearAll();
  openStore.clearAll();
});

afterEach(() => {
  store._setClock();
  delete process.env.OPEN_GUEST_RELEASE_MS;
});

async function json(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (key) headers['X-Lyceum-Guest'] = key;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const H = '/api/human';
const newRoom = async () => (await json('POST', `${H}/rooms`, {})).data.room_id;
const join = (room, handle, key) => json('POST', `${H}/rooms/${room}/join`, { handle, party: 'human' }, key);
const post = (room, handle, body, key) => json('POST', `${H}/rooms/${room}/post`, { handle, body, party: 'human' }, key);
const leave = (room, handle, key) => json('POST', `${H}/rooms/${room}/leave`, { handle, party: 'human' }, key);
const read = (room, handle, key) => json('GET', `${H}/rooms/${room}/messages?handle=${encodeURIComponent(handle)}`, undefined, key);

/** Join as a new Human guest and return its key. */
async function guest(room, handle) {
  const r = await join(room, handle);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.guest_key;
}

describe('Human: joining as a guest', () => {
  it('a keyless join returns a guest_key once, and never again', async () => {
    const first = await join('welcome', 'ana');
    assert.equal(first.status, 200);
    assert.match(first.data.guest_key, /^g_[A-Za-z0-9_-]{43}$/);
    const again = await join('welcome', 'ana', first.data.guest_key);
    assert.equal(again.status, 200);
    assert.equal(again.data.guest_key, undefined);
    const elsewhere = await join('topic-interconnectivity', 'ana', first.data.guest_key);
    assert.equal(elsewhere.status, 200);
    assert.equal(elsewhere.data.guest_key, undefined);
    // Two keyless joins are two different guests with two different keys.
    const other = await guest('welcome', 'bo');
    assert.notEqual(other, first.data.guest_key);
  });

  it('a refused join hands out no key', async () => {
    await guest('welcome', 'ana');
    const refused = await join('welcome', 'ana');
    assert.equal(refused.status, 409);
    assert.equal(refused.data.guest_key, undefined);
    assert.equal(store._guests.size, 1);
  });

  it('an unknown or malformed key counts as no key: the join mints a fresh one', async () => {
    const made = await join('welcome', 'ana', `g_${'A'.repeat(43)}`);
    assert.equal(made.status, 200);
    assert.match(made.data.guest_key, /^g_/);
    const odd = await join('welcome', 'bo', 'not-a-key');
    assert.match(odd.data.guest_key, /^g_/);
  });
});

describe('Human: reload keeps your name', () => {
  it('rejoining with the key re-seats the same entry: same name, same joined_at, no ghost', async () => {
    const key = await guest('welcome', 'ana');
    const before = (await read('welcome', 'ana', key)).data.roster;
    const reload = await join('welcome', 'ana', key);
    assert.equal(reload.status, 200);
    assert.deepEqual(reload.data.roster, before);
    assert.equal(reload.data.roster.filter((p) => p.handle === 'ana').length, 1);
    assert.equal((await post('welcome', 'ana', 'back after reload', key)).status, 201);
  });

  it('you can leave and come back with the same key; once left, the name is free to others', async () => {
    const key = await guest('welcome', 'ana');
    assert.equal((await leave('welcome', 'ana', key)).status, 200);
    const back = await join('welcome', 'ana', key);
    assert.equal(back.status, 200);
    assert.equal(back.data.guest_key, undefined);
    assert.equal((await leave('welcome', 'ana', key)).status, 200);
    const someoneElse = await join('welcome', 'ana');
    assert.equal(someoneElse.status, 200);
    assert.match(someoneElse.data.guest_key, /^g_/);
  });
});

describe('Human: nobody else can use your name while it is yours', () => {
  it('no key, another key and lookalikes all get the same generic 409 as Open', async () => {
    const key = await guest('welcome', 'ana');
    const stranger = await guest('welcome', 'bo');
    const refusals = [
      await join('welcome', 'ana'),
      await join('welcome', 'ana', stranger),
      await join('welcome', 'ANA'),
      await join('welcome', '\u0430na'), // Cyrillic а
      await join('welcome', '\uff41\uff4e\uff41'), // fullwidth ａｎａ
      await join('welcome', 'ána'),
    ];
    for (const r of refusals) {
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.error.code, 'handle_taken');
      assert.equal(r.data.error.message, guestIdentity.NAME_TAKEN_MESSAGE);
      assert.equal(r.data.guest_key, undefined);
    }
    // Same body as Open's refusal, word for word, and nothing names the holder or the key.
    const openRoom = (await json('POST', '/api/open/rooms', { title: 'x' })).data.room_id;
    await json('POST', `/api/open/rooms/${openRoom}/join`, { handle: 'ana', party: 'human' });
    const openRefusal = await json('POST', `/api/open/rooms/${openRoom}/join`, { handle: 'ana', party: 'human' });
    assert.deepEqual(refusals[0].data, openRefusal.data);
    for (const r of refusals) {
      const text = JSON.stringify(r.data);
      assert.equal(text.includes(key), false);
      assert.equal(text.includes('gst_'), false);
      assert.equal(/ana/i.test(text.replace(/name/gi, '')), false);
    }
    assert.equal((await join('welcome', 'ana', key)).status, 200);
    // The name is per room: another room is free.
    assert.equal((await join('topic-interconnectivity', 'ana')).status, 200);
  });

  it('post, read as, leave, branch and merge need the key: 401 without, 403 not_joined with the wrong one', async () => {
    const room = await newRoom();
    const key = await guest(room, 'ana');
    const stranger = await guest(room, 'bo');
    const target = await newRoom();
    await join(target, 'ana', key);
    const r = `${H}/rooms/${room}`;
    const calls = [
      ['POST', `${r}/post`, { handle: 'ana', body: 'hello', party: 'human' }],
      ['GET', `${r}/messages?handle=ana`, undefined],
      ['POST', `${r}/branch`, { handle: 'ana', party: 'human' }],
      ['POST', `${r}/merge`, { handle: 'ana', party: 'human', target_id: target }],
      ['POST', `${r}/leave`, { handle: 'ana', party: 'human' }],
    ];
    for (const [method, path, body] of calls) {
      const none = await json(method, path, body);
      assert.equal(none.status, 401, `${method} ${path} without a key`);
      assert.equal(none.data.error.code, 'guest_key_required');
      const wrong = await json(method, path, body, stranger);
      assert.equal(wrong.status, 403, `${method} ${path} with another key`);
      assert.equal(wrong.data.error.code, 'not_joined');
    }
    // Nothing changed: still seated, no messages, not merged, no branch.
    const seen = await read(room, 'ana', key);
    assert.equal(seen.status, 200);
    assert.equal(seen.data.messages.length, 0);
    assert.equal(seen.data.merged_into, null);
    assert.ok(seen.data.roster.some((p) => p.handle === 'ana'));
    assert.equal(store._rooms.size, 13 + 2, 'welcome + 12 topics + the two test rooms');
    // With the key, every one of them works (merge last but one: it empties the source roster,
    // so it runs after leave and a rejoin).
    for (const [method, path, body] of calls.filter(([, p]) => !p.endsWith('/merge'))) {
      const ok = await json(method, path, body, key);
      assert.ok(ok.status === 200 || ok.status === 201, `${method} ${path} with the key: ${ok.status} ${JSON.stringify(ok.data)}`);
    }
    assert.equal((await join(room, 'ana', key)).status, 200);
    const merged = await json('POST', `${r}/merge`, { handle: 'ana', party: 'human', target_id: target }, key);
    assert.equal(merged.status, 200, JSON.stringify(merged.data));
  });

  it('public reads without ?handle= stay open to anyone (room text is public)', async () => {
    const key = await guest('welcome', 'ana');
    await post('welcome', 'ana', 'hi', key);
    const anon = await json('GET', `${H}/rooms/welcome/messages`);
    assert.equal(anon.status, 200);
    assert.equal(anon.data.messages.length, 1);
  });

  it('a name that is not joined is still not_joined, key or no key', async () => {
    const key = await guest('welcome', 'ana');
    assert.equal((await post('welcome', 'nobody', 'hi')).data.error.code, 'not_joined');
    assert.equal((await post('welcome', 'nobody', 'hi', key)).data.error.code, 'not_joined');
    assert.equal((await leave('welcome', 'nobody', key)).data.error.code, 'not_joined');
  });

  it('a branch seats its creator under the same key; nobody else can act as them there', async () => {
    const parent = await newRoom();
    const key = await guest(parent, 'ana');
    const stranger = await guest(parent, 'bo');
    const branch = await json('POST', `${H}/rooms/${parent}/branch`, { handle: 'ana', party: 'human' }, key);
    assert.equal(branch.status, 201);
    const child = branch.data.room_id;
    assert.equal((await post(child, 'ana', 'in the branch', key)).status, 201);
    assert.equal((await post(child, 'ana', 'imposter', stranger)).status, 403);
    assert.equal((await join(child, 'ana')).status, 409);
  });
});

describe('Human: the limits', () => {
  it('a name unused for 30 days is released: held at 29 days, free after 30, old key no longer acts', async () => {
    const t0 = Date.now();
    const ana = await guest('welcome', 'ana');
    store._setClock(() => t0 + 29 * 24 * 3600 * 1000);
    assert.equal((await join('welcome', 'ana')).status, 409, 'held at 29 days');
    store._setClock(() => t0 + guestIdentity.DEFAULT_GUEST_RELEASE_MS + 60 * 1000);
    const taken = await join('welcome', 'ana');
    assert.equal(taken.status, 200, 'released after 30 days');
    assert.notEqual(taken.data.guest_key, ana);
    const old = await post('welcome', 'ana', 'still me?', ana);
    assert.equal(old.status, 403);
    assert.equal(old.data.error.code, 'not_joined');
  });

  it('any use restarts the 30 days: a post, a read or a rejoin', async () => {
    const t0 = Date.now();
    const ana = await guest('welcome', 'ana');
    store._setClock(() => t0 + 20 * 24 * 3600 * 1000);
    assert.equal((await post('welcome', 'ana', 'still here', ana)).status, 201);
    store._setClock(() => t0 + 45 * 24 * 3600 * 1000);
    assert.equal((await join('welcome', 'ana')).status, 409);
    assert.equal((await read('welcome', 'ana', ana)).status, 200);
  });

  it('OPEN_GUEST_RELEASE_MS (shared with Open) shortens the window for Human too', async () => {
    process.env.OPEN_GUEST_RELEASE_MS = '7200000';
    const t0 = Date.now();
    await guest('welcome', 'ana');
    store._setClock(() => t0 + 7200000 + 60 * 1000);
    assert.equal((await join('welcome', 'ana')).status, 200);
  });
});

describe('Human: names per guest key', () => {
  it(`one key holds at most ${guestIdentity.MAX_NAMES_PER_GUEST} names; the same name in more rooms counts once`, async () => {
    assert.equal(guestIdentity.MAX_NAMES_PER_GUEST, 5);
    const rooms = [];
    for (let i = 0; i < 7; i++) rooms.push(await newRoom());
    const key = await guest(rooms[0], 'n0');
    for (let i = 1; i < 5; i++) assert.equal((await join(rooms[i], `n${i}`, key)).status, 200);
    const sixth = await join(rooms[5], 'n5', key);
    assert.equal(sixth.status, 403);
    assert.equal(sixth.data.error.code, 'guest_name_limit');
    assert.equal(sixth.data.guest_key, undefined);
    assert.equal((await join(rooms[5], 'n0', key)).status, 200, 'a name it already holds still works in a new room');
    assert.equal((await join(rooms[0], 'n0', key)).status, 200, 'rejoining a held name is fine');
    assert.equal((await leave(rooms[4], 'n4', key)).status, 200);
    assert.equal((await join(rooms[6], 'n6', key)).status, 200, 'leaving frees a slot');
    assert.equal((await join(rooms[6], 'other')).status, 200, 'a different key is unaffected');
  });
});

describe('Human: what we store', () => {
  it('only a sha256 of the key is kept, and it survives a snapshot round trip', async () => {
    const ana = await guest('welcome', 'ana');
    await post('welcome', 'ana', 'hello', ana);
    const snap = persist.serialize();
    const text = JSON.stringify(snap);
    assert.equal(text.includes(ana), false);
    const hash = crypto.createHash('sha256').update(ana).digest('hex');
    assert.ok(snap.human.guests.some(([h]) => h === hash));
    const [record] = Array.from(store._guests.values());
    assert.equal(record.type, 'guest');
    assert.equal(record.account_id, null);
    store.clearAll();
    persist.restore(JSON.parse(text));
    assert.equal((await post('welcome', 'ana', 'after restart', ana)).status, 201);
    assert.equal((await join('welcome', 'ana')).status, 409);
  });

  it('the key and guest id are never shown in rosters, messages or topics', async () => {
    const ana = await guest('welcome', 'ana');
    const bo = await guest('welcome', 'bo');
    await post('welcome', 'ana', 'hello', ana);
    for (const r of [await read('welcome', 'bo', bo), await json('GET', `${H}/topics`), await join('welcome', 'bo', bo)]) {
      const text = JSON.stringify(r.data);
      assert.equal(text.includes(ana), false);
      assert.equal(text.includes('gst_'), false);
      assert.equal(text.includes('owner'), false);
    }
  });

  it('Human and Open keep separate registries: a key from one stream means nothing in the other', async () => {
    const humanKey = await guest('welcome', 'ana');
    const openJoin = await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'ana', party: 'human' });
    const openKey = openJoin.data.guest_key;
    assert.match(openKey, /^g_/);
    assert.notEqual(openKey, humanKey);
    assert.equal(store._guests.size, 1);
    assert.equal(openStore._guests.size, 1);
    // The Open key cannot act as ana in Human, nor the Human key in Open: each counts as no key.
    const crossedHuman = await post('welcome', 'ana', 'x', openKey);
    assert.equal(crossedHuman.status, 401);
    assert.equal(crossedHuman.data.error.code, 'guest_key_required');
    const crossed = await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'ana', body: 'x' }, humanKey);
    assert.equal(crossed.status, 401);
    // Human rooms never appear in the Open store and the other way round.
    assert.equal(openStore._openRooms.has('welcome'), false);
    assert.equal(store._rooms.has('open-welcome'), false);
  });
});

describe('Human: names from before guest keys', () => {
  it('an ownerless roster entry counts as away: it is dropped on the next read and the first joiner gets the name', async () => {
    const room = store._rooms.get('welcome');
    room.roster.set('floor-smoke-0925', { handle: 'floor-smoke-0925', joined_at: new Date().toISOString() });
    const listed = await json('GET', `${H}/rooms/welcome/messages`);
    assert.equal(listed.data.roster.some((p) => p.handle === 'floor-smoke-0925'), false);
    const claim = await join('welcome', 'floor-smoke-0925');
    assert.equal(claim.status, 200);
    assert.match(claim.data.guest_key, /^g_/);
    assert.equal((await join('welcome', 'floor-smoke-0925')).status, 409, 'held from now on');
  });

  it('an old snapshot (no human.guests, ownerless rosters) restores cleanly', async () => {
    const snap = persist.serialize();
    delete snap.human.guests;
    const welcome = snap.human.rooms.find((r) => r.id === 'welcome');
    welcome.roster = [['old', { handle: 'old', joined_at: new Date().toISOString() }]];
    persist.restore(snap);
    assert.equal(store._guests.size, 0);
    const topics = await json('GET', `${H}/topics`);
    assert.equal(topics.status, 200);
    assert.equal((await join('welcome', 'old')).status, 200);
  });
});

describe('Human: still refuses AI parties', () => {
  it('party "ai" is 403 not_human with or without a Human guest key, and mints nothing', async () => {
    const key = await guest('welcome', 'ana');
    const before = store._guests.size;
    for (const k of [undefined, key, 'not-a-key']) {
      const r = await json('POST', `${H}/rooms/welcome/join`, { handle: 'bot', party: 'ai' }, k);
      assert.equal(r.status, 403);
      assert.equal(r.data.error.code, 'not_human');
      assert.equal(r.data.guest_key, undefined);
    }
    const asAi = await json('POST', `${H}/rooms/welcome/post`, { handle: 'ana', body: 'x', party: 'ai' }, key);
    assert.equal(asAi.status, 403);
    assert.equal(asAi.data.error.code, 'not_human');
    const leaveAi = await json('POST', `${H}/rooms/welcome/leave`, { handle: 'ana', party: 'ai' }, key);
    assert.equal(leaveAi.data.error.code, 'not_human');
    assert.equal(store._guests.size, before);
    assert.ok((await read('welcome', 'ana', key)).data.roster.some((p) => p.handle === 'ana'));
  });
});
