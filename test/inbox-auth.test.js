/**
 * Inbox auth: a name alone no longer opens an inbox (it gave out a person's room ids, unlisted
 * rooms included). AIs read theirs with a room credential; people get one back with guest keys (#33).
 */
const { describe, it, before, after } = require('node:test');
const { guestHeaders, remember, keyFor } = require('./guest-jar');
const assert = require('node:assert/strict');
const openStore = require('../src/openStore');

let server;
let base;

before(async () => {
  const app = require('../src/server');
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function json(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...guestHeaders(path, body, headers), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  remember(path, body, data);
  return { status: res.status, data };
}

describe('Inbox auth', () => {
  it('refuses an inbox by name, and gives out no room ids', async () => {
    openStore.clearAll();
    const created = await json('POST', '/api/open/rooms', { title: 'hidden', visibility: 'unlisted' });
    const room = created.data.room_id;
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'victim', party: 'human' });
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'friend', party: 'human' });
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'friend', body: 'secret plans' });
    // A name alone, with no guest key, reads nothing (#33 brings the human inbox back by key only).
    for (const path of ['/api/open/inbox?handle=victim', '/api/open/inbox']) {
      const res = await fetch(base + path);
      const data = await res.json();
      assert.equal(res.status, 401);
      assert.equal(data.error.code, 'guest_key_required');
      assert.ok(!JSON.stringify(data).includes(room), 'no room id in the refusal');
    }
    // Someone else's guest key does not read victim's rooms either.
    const other = await fetch(base + '/api/open/inbox?handle=victim', { headers: { 'X-Lyceum-Guest': keyFor('friend') } });
    const otherItems = (await other.json()).items;
    assert.ok(!otherItems.some((i) => i.handle === 'victim'), "friend's key lists only friend's names");
    // The guest key that holds the name does.
    const own = await json('GET', '/api/open/inbox?handle=victim');
    assert.equal(own.status, 200);
    assert.ok(own.data.items.some((i) => i.room_id === room && i.handle === 'victim'));
  });

  it('a bad Bearer is 401; a good one still reads the AI inbox', async () => {
    const bad = await json('GET', '/api/open/inbox', undefined, { Authorization: 'Bearer nope' });
    assert.equal(bad.status, 401);
    const joined = await json('POST', '/api/open/rooms/open-welcome/join', { agent_id: 'inbox-bot', party: 'ai' });
    assert.equal(joined.status, 200);
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    await json('POST', '/api/open/rooms/open-welcome/post', { handle: 'jason', body: 'hi @inbox-bot' });
    const ok = await json('GET', '/api/open/inbox', undefined, { Authorization: `Bearer ${joined.data.credential}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.agent_id, 'inbox-bot');
    assert.ok(ok.data.items.some((i) => i.room_id === 'open-welcome'));
  });

  it('I-1: an AI credential named like a person gets none of that person\'s rooms', async () => {
    openStore.clearAll();
    const hidden = (await json('POST', '/api/open/rooms', { title: 'hidden', visibility: 'unlisted' })).data.room_id;
    await json('POST', `/api/open/rooms/${hidden}/join`, { handle: 'victim', party: 'human' });
    await json('POST', `/api/open/rooms/${hidden}/join`, { handle: 'friend', party: 'human' });
    await json('POST', `/api/open/rooms/${hidden}/post`, { handle: 'friend', body: 'hey @victim, plans attached', awaiting: ['victim'] });
    const own = (await json('POST', '/api/open/rooms', { title: 'mine' })).data.room_id;
    const imp = await json('POST', `/api/open/rooms/${own}/join`, { agent_id: 'victim', party: 'ai' });
    assert.equal(imp.status, 200);
    const auth = { Authorization: `Bearer ${imp.data.credential}` };
    for (const path of ['/api/open/inbox', '/api/open/inbox?handle=victim', '/api/open/inbox?agent_id=victim']) {
      const res = await json('GET', path, undefined, auth);
      assert.equal(res.status, 200);
      assert.equal(res.data.room_id, own);
      assert.ok(res.data.items.every((i) => i.room_id === own), path);
      assert.ok(!JSON.stringify(res.data).includes(hidden), path);
    }
  });

  it('I-1: a credential sees only its own room, even for a real agent in several rooms', async () => {
    openStore.clearAll();
    const a = (await json('POST', '/api/open/rooms', { title: 'A' })).data.room_id;
    const b = (await json('POST', '/api/open/rooms', { title: 'B' })).data.room_id;
    const inA = await json('POST', `/api/open/rooms/${a}/join`, { agent_id: 'multi-bot', party: 'ai' });
    await json('POST', `/api/open/rooms/${b}/join`, { agent_id: 'multi-bot', party: 'ai' });
    for (const r of [a, b]) {
      await json('POST', `/api/open/rooms/${r}/join`, { handle: 'jason', party: 'human' });
      await json('POST', `/api/open/rooms/${r}/post`, { handle: 'jason', body: 'over to you', awaiting: ['multi-bot'] });
    }
    const res = await json('GET', '/api/open/inbox', undefined, { Authorization: `Bearer ${inA.data.credential}` });
    assert.deepEqual(res.data.items.map((i) => i.room_id), [a]);
    assert.equal(res.data.items[0].your_turn, true);
    // A left agent's credential is revoked.
    await json('POST', `/api/open/rooms/${a}/leave`, {}, { Authorization: `Bearer ${inA.data.credential}` });
    const gone = await json('GET', '/api/open/inbox', undefined, { Authorization: `Bearer ${inA.data.credential}` });
    assert.equal(gone.status, 401);
  });
});
