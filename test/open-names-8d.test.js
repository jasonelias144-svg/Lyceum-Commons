/**
 * Follow-ups from Handoff 8d: control characters in names, and @mentions that compare names
 * the way joins do.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
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

beforeEach(() => openStore.clearAll());

async function json(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const newRoom = async () => (await json('POST', '/api/open/rooms', { title: '8d' })).data.room_id;
const joinHuman = (room, handle) => json('POST', `/api/open/rooms/${room}/join`, { handle, party: 'human' });

describe('Follow-ups from Handoff 8d', () => {
  it('8d-1: control characters do not make a new name, and new handles with them are refused', async () => {
    const room = await newRoom();
    await joinHuman(room, 'jason');
    for (const bad of ['jason\u0085', '\u0085', 'ja\u009fson', '\u0080\u0080']) {
      const res = await joinHuman(room, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.data.error.code, 'invalid_handle');
    }
    for (const variant of ['jason\u{16FE4}', 'jason\u{1D159}']) {
      assert.equal((await joinHuman(room, variant)).status, 409, JSON.stringify(variant));
    }
    assert.equal(openStore.sameId('jason\u0085', 'jason'), true);
    // A handle joined before this rule can still re-join.
    openStore._openRooms.get(room).members['human:old\u0085name'] = true;
    assert.equal((await joinHuman(room, 'old\u0085name')).status, 200);
  });

  it('8d-2: @mentions compare names the way joins do', async () => {
    const m = openStore.mentionsName;
    for (const body of ['hi @ana', 'hi @ANA', 'hi @\u0430na', 'hi @\uff41\uff4e\uff41', 'thanks @ana.', '@ana, over to you', '(@ana)']) {
      assert.equal(m(body, 'ana'), true, body);
    }
    for (const body of ['hi @ana-bot', 'hi @ana.bot', 'hi @anabel', 'ana', 'hi @ an a', 'email ana@x.org']) {
      assert.equal(m(body, 'ana'), false, body);
    }
    assert.equal(m('ask @Mar\u00eda', 'maria'), true);
    assert.equal(m('ask @claude-jason now', 'claude-jason'), true);

    const room = await newRoom();
    await joinHuman(room, 'ana');
    await joinHuman(room, 'keeper');
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'keeper', body: 'what do you think, @\u0430na?' });
    const inbox = await json('GET', '/api/open/inbox?handle=ana');
    const item = inbox.data.items.find((i) => i.room_id === room);
    assert.equal(item.mentions, 1);
  });
});
