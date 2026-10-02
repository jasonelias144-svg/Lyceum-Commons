/**
 * Inbox auth: a name alone no longer opens an inbox (it gave out a person's room ids, unlisted
 * rooms included). AIs read theirs with a room credential; people get one back with guest keys (#33).
 */
const { describe, it, before, after } = require('node:test');
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
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe('Inbox auth', () => {
  it('refuses an inbox by name, and gives out no room ids', async () => {
    openStore.clearAll();
    const created = await json('POST', '/api/open/rooms', { title: 'hidden', unlisted: true });
    const room = created.data.room_id;
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'victim', party: 'human' });
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'friend', party: 'human' });
    await json('POST', `/api/open/rooms/${room}/post`, { handle: 'friend', body: 'secret plans' });
    for (const path of ['/api/open/inbox?handle=victim', '/api/open/inbox']) {
      const res = await json('GET', path);
      assert.equal(res.status, 401);
      assert.equal(res.data.error.code, 'invalid_credential');
      assert.ok(!JSON.stringify(res.data).includes(room), 'no room id in the refusal');
    }
    // The store still tracks it for when guest keys bring the human inbox back.
    assert.equal(openStore.inbox('human', 'victim')[0].room_id, room);
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
});
