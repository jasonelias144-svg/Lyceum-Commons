/**
 * POST /api/open/rooms is rate limited per address (OPEN_CREATE_IP_RATE_PER_MIN), and a room
 * nobody ever joined is deleted once one presence TTL has passed since it was created.
 */
process.env.OPEN_CREATE_IP_RATE_PER_MIN = '2';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const openStore = require('../src/openStore');
const rateLimit = require('../src/rateLimit');

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
  openStore._setClock();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  openStore._setClock();
  openStore.clearAll();
  if (rateLimit._reset) rateLimit._reset();
});

const create = () =>
  fetch(`${base}/api/open/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

describe('Open room create rate limit', () => {
  it('returns 429 rate_limited with Retry-After past the per-address limit', async () => {
    assert.equal((await create()).status, 201);
    assert.equal((await create()).status, 201);
    const res = await create();
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    const body = await res.json();
    assert.equal(body.error.code, 'rate_limited');
    assert.equal(body.error.message, "You're creating rooms quickly.");
  });
});

describe('never-joined Open rooms expire', () => {
  const TTL = openStore.DEFAULT_PRESENCE_TTL_MS;

  it('keeps an unjoined room until exactly one TTL, then deletes it', () => {
    let t = Date.now() + 1000;
    openStore._setClock(() => t);
    const room = openStore.createRoom({});
    t += TTL - 1;
    assert.ok(openStore.getRoom(room.id));
    assert.ok(openStore.listRooms().some((r) => r.id === room.id));
    t += 1; // exactly TTL since creation
    assert.ok(!openStore.listRooms().some((r) => r.id === room.id));
    assert.equal(openStore.getRoom(room.id), null);
  });

  it('a stale fetch gets 404 room_expired with the closed copy', async () => {
    let t = Date.now() + 1000;
    openStore._setClock(() => t);
    const room = openStore.createRoom({});
    t += TTL + 1000;
    const res = await fetch(`${base}/api/open/rooms/${room.id}/messages`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'room_expired');
    assert.equal(body.error.message, 'This room closed because no one joined.');
    const other = await fetch(`${base}/api/open/rooms/orm_nope/messages`);
    assert.equal((await other.json()).error.code, 'room_not_found');
  });

  it('a room someone joined is not expired by this rule', () => {
    let t = Date.now() + 1000;
    openStore._setClock(() => t);
    const room = openStore.createRoom({});
    openStore.joinAi(room, 'agent-1');
    t += TTL * 3;
    // the agent times out but stays a member, so the room and its history are kept
    assert.ok(openStore.getRoom(room.id));
    assert.ok(openStore.listRooms().some((r) => r.id === room.id));
  });

  it('a room a human joined once never expires via this path', () => {
    let t = Date.now() + 1000;
    openStore._setClock(() => t);
    const room = openStore.createRoom({});
    openStore.joinHuman(room, 'ada');
    t += TTL * 3;
    assert.ok(openStore.getRoom(room.id));
    assert.equal(openStore.wasExpiredUnjoined(room.id), false);
  });

  it('never deletes the welcome lobby', () => {
    let t = Date.now() + 1000;
    openStore._setClock(() => t);
    t += TTL * 5;
    assert.ok(openStore.getRoom(openStore.OPEN_WELCOME_ROOM_ID));
  });
});
