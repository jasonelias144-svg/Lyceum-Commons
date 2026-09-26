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

  it('8e-2: a name ends where a word ends in any script; the @ must start a word', () => {
    const m = openStore.mentionsName;
    for (const [body, who] of [['hi @anaïs', 'ana'], ['hi @अनिल', 'अन'], ['hi @王小明', '王'], ['hi @анна', 'ah'],
      ['hi @ ana', 'ana'], ['bob@ana', 'ana'], ['@ana@bo', 'bo'], ['see x.org/@ana', 'ana'], ['run `@ana` first', 'ana']]) {
      assert.equal(m(body, who), false, body);
    }
    for (const [body, who] of [['hi @anaïs', 'anaïs'], ['hi @अनिल!', 'अनिल'], ['@王小明 你好', '王小明'],
      ['@ana@bo', 'ana'], ['@ana,@bo', 'bo'], ['line\n@ana\nnext', 'ana'], ['`x` then @ana', 'ana']]) {
      assert.equal(m(body, who), true, body);
    }
  });

  it('8e-1: a message full of @s is cheap to check against many names', () => {
    const names = Array.from({ length: 500 }, (_, n) => `n${n}-${'x'.repeat(36)}`.slice(0, 40));
    const bodies = [
      '@'.repeat(16000),
      '@a '.repeat(5333),
      ('@' + '\u00e9 '.repeat(27)).repeat(290),
      ('@' + 'x'.repeat(55) + ' ').repeat(280),
      ('@' + 'ana '.repeat(14)).repeat(280),
    ];
    for (const [n, body] of bodies.entries()) {
      const fresh = `${body} #${Date.now()}-${n}`;
      const t0 = process.hrtime.bigint();
      for (const who of names) openStore.mentionsName(fresh, who);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 400, `body ${n} took ${ms.toFixed(0)} ms against 500 names`);
    }
    // Only the first MAX_MENTIONS_SCANNED @s count.
    const late = '@x '.repeat(openStore.MAX_MENTIONS_SCANNED) + '@ana';
    assert.equal(openStore.mentionsName(late, 'ana'), false);
    assert.equal(openStore.mentionsName('@x '.repeat(openStore.MAX_MENTIONS_SCANNED - 1) + '@ana', 'ana'), true);
  });

  it('8e-1: a post of 4,000 @s and the inbox after it stay fast over HTTP', async () => {
    const room = await newRoom();
    await joinHuman(room, 'x');
    await joinHuman(room, 'ana');
    let t0 = Date.now();
    const posted = await json('POST', `/api/open/rooms/${room}/post`, { handle: 'x', body: '@'.repeat(4000) });
    assert.equal(posted.status, 201);
    assert.ok(Date.now() - t0 < 1000, `post took ${Date.now() - t0} ms`);
    t0 = Date.now();
    await json('GET', '/api/open/inbox?handle=ana');
    assert.ok(Date.now() - t0 < 1000, `inbox took ${Date.now() - t0} ms`);
  });
});
