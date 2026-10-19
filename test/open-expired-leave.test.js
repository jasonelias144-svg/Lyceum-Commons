/**
 * Open: an AI seat expired by the presence TTL can still leave (200 already_left), which
 * drops its membership and lets an emptied room be deleted. Post/read stay 401.
 */
'use strict';
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { guestHeaders, remember } = require('./guest-jar');
const openStore = require('../src/openStore');

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


async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...guestHeaders(path, body, headers), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  remember(path, body, data);
  return { status: res.status, data };
}

describe('Leave with an expired AI seat', () => {
  const TTL = openStore.DEFAULT_PRESENCE_TTL_MS;
  let t;
  beforeEach(() => {
    t = Date.now();
    openStore._setClock(() => t);
  });
  afterEach(() => openStore._setClock());

  async function expiredSeat(extraHuman) {
    const room = (await json('POST', '/api/open/rooms', { title: 'Expiry' })).data.room_id;
    if (extraHuman) await json('POST', `/api/open/rooms/${room}/join`, { handle: 'jason', party: 'human' });
    const bot = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'sleepy-bot', party: 'ai' });
    assert.equal(bot.status, 200);
    await json('POST', `/api/open/rooms/${room}/post`, { body: 'hi' }, { Authorization: `Bearer ${bot.data.credential}` });
    t += TTL + 1000;
    return { room, auth: { Authorization: `Bearer ${bot.data.credential}` } };
  }

  it('last member: leave is 200 already_left and the room is deleted', async () => {
    const { room, auth } = await expiredSeat(false);
    const left = await json('POST', `/api/open/rooms/${room}/leave`, {}, auth);
    assert.equal(left.status, 200);
    assert.equal(left.data.ok, true);
    assert.equal(left.data.already_left, true);
    assert.deepEqual(left.data.roster, []);
    assert.equal(openStore._openRooms.has(room), false);
  });

  it('with others still in: member dropped, room kept; post/read stay 401; second leave is 401', async () => {
    const { room, auth } = await expiredSeat(true);
    // Post and read do not use the expired record (the first call also triggers the sweep).
    const post = await json('POST', `/api/open/rooms/${room}/post`, { body: 'late' }, auth);
    assert.equal(post.status, 401);
    assert.equal(post.data.error.code, 'invalid_credential');
    const read = await json('GET', `/api/open/rooms/${room}/messages`, undefined, auth);
    assert.equal(read.status, 401);
    assert.equal(read.data.error.code, 'invalid_credential');
    const left = await json('POST', `/api/open/rooms/${room}/leave`, {}, auth);
    assert.equal(left.status, 200);
    assert.equal(left.data.already_left, true);
    const r = openStore.getRoom(room);
    assert.ok(r);
    assert.equal(openStore.hasAi(r, 'sleepy-bot'), false);
    assert.equal(Boolean(r.members['ai:sleepy-bot']), false);
    const again = await json('POST', `/api/open/rooms/${room}/leave`, {}, auth);
    assert.equal(again.status, 401);
    const post2 = await json('POST', `/api/open/rooms/${room}/post`, { body: 'later' }, auth);
    assert.equal(post2.status, 401);
  });

  it('a random token, or an expired token aimed at another room, is still 401', async () => {
    const { room, auth } = await expiredSeat(true);
    const other = (await json('POST', '/api/open/rooms', { title: 'Other' })).data.room_id;
    await json('POST', `/api/open/rooms/${other}/join`, { handle: 'jason', party: 'human' });
    const rnd = await json('POST', `/api/open/rooms/${room}/leave`, {}, { Authorization: 'Bearer not-a-real-token' });
    assert.equal(rnd.status, 401);
    assert.equal(rnd.data.error.code, 'invalid_credential');
    // Trigger the sweep for room, then try the token against the other room.
    await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    const wrong = await json('POST', `/api/open/rooms/${other}/leave`, {}, auth);
    assert.equal(wrong.status, 401);
    assert.ok(openStore.getRoom(room).members['ai:sleepy-bot']);
  });

  it('an agent back on a new seat is not removed by its old expired token', async () => {
    const { room, auth } = await expiredSeat(true);
    await json('GET', `/api/open/rooms/${room}/messages?handle=jason`);
    const fresh = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'sleepy-bot', party: 'ai' });
    assert.equal(fresh.status, 200);
    const old = await json('POST', `/api/open/rooms/${room}/leave`, {}, auth);
    assert.equal(old.status, 401);
    assert.ok(openStore.hasAi(openStore.getRoom(room), 'sleepy-bot'));
  });
});
