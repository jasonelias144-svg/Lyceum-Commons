/**
 * Names and @mentions (Handoffs 8d and 8e, re-landed with the R8e-1 fix): control characters in
 * names, @mentions that compare names the way joins do, and bounded mention work and memory.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const { guestHeaders, remember } = require('./guest-jar');
const assert = require('node:assert/strict');
const openStore = require('../src/openStore');
const persist = require('../src/persist');

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

const newRoom = async () => (await json('POST', '/api/open/rooms', { title: '8d' })).data.room_id;
const storeInbox = (handle) => ({ data: { items: openStore.inbox('human', handle) } });
/** QC Handoff 12's crafted body: 64 @s, each a name that folds long, followed by many places a name could end. */
const crafted = (u) =>
  Array.from({ length: 64 }, (_, i) => '@' + String.fromCharCode(0x4e00 + i, 0x3400 + u) + '\ufdfa' + '!'.repeat(52))
    .join(' ')
    .slice(0, 3990);
const joinHuman = (room, handle) => json('POST', `/api/open/rooms/${room}/join`, { handle, party: 'human' });

describe('Names and @mentions (8d, 8e, R8e-1)', () => {
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
    const inbox = storeInbox('ana');
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
    storeInbox('ana');
    assert.ok(Date.now() - t0 < 1000, `inbox took ${Date.now() - t0} ms`);
  });

  it('R8e-1: over 256 distinct worst-case posts, the inbox stays fast and each index stays small', async () => {
    const room = await newRoom();
    await joinHuman(room, 'x');
    await joinHuman(room, 'ana');
    const r = openStore._openRooms.get(room);
    for (let u = 0; u < 300; u++) {
      const body = Array.from({ length: 64 }, (_, i) =>
        '@' + String.fromCodePoint(0x4e00 + i, 0x3400 + u) + '\ufdfa!'.repeat(27)).join(' ');
      openStore.addMessage(r, { author: 'x', party: 'human', body });
    }
    for (const rep of [1, 2]) {
      const t0 = Date.now();
      const items = openStore.inbox('human', 'nobody');
      openStore.inbox('human', 'ana');
      assert.equal(items.length, 0);
      assert.ok(Date.now() - t0 < 1000, `inbox ${rep} took ${Date.now() - t0} ms`);
    }
    // A worst-case post is cheap to index, and its mentions still work.
    const body = '@a' + '!'.repeat(80) + (' @b' + '!'.repeat(80)).repeat(80);
    const t0 = Date.now();
    const m = openStore.addMessage(r, { author: 'x', party: 'human', body });
    assert.ok(Date.now() - t0 < 200, `post took ${Date.now() - t0} ms`);
    assert.equal(openStore.mentionsName(m, 'b!!'), true);
  });

  it('R8e-1: a new name may fold to at most MAX_NAME_KEY characters, and long AI ids can be mentioned', async () => {
    const room = await newRoom();
    const long = '\ufdfa'.repeat(4); // each folds to 18 characters
    const res = await joinHuman(room, long);
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'invalid_handle');
    assert.equal((await joinHuman(room, '\ufdfa'.repeat(3))).status, 200);
    assert.equal(openStore.mentionsName(`hi @${'\ufdfa'.repeat(3)}!`, '\ufdfa'.repeat(3)), true);
    const ai = 'a'.repeat(64);
    assert.equal(openStore.mentionsName(`over to you @${ai}.`, ai), true);
    assert.equal(openStore.mentionsName(`over to you @${ai}x`, ai), false);
  });

  it('R12-2: a crafted post costs a few milliseconds, not tens', async () => {
    const room = await newRoom();
    await joinHuman(room, 'x');
    const r = openStore._openRooms.get(room);
    const n = 50;
    const t0 = process.hrtime.bigint();
    for (let u = 1; u <= n; u++) openStore.addMessage(r, { author: 'x', party: 'human', body: crafted(u) });
    const avg = Number(process.hrtime.bigint() - t0) / 1e6 / n;
    assert.ok(avg < 10, `a crafted post took ${avg.toFixed(1)} ms on average`);
    // The caps keep ordinary names mentionable: up to 16 places a name could end per @.
    const sixteen = 'a b c d e f g h i j k l m n o p';
    assert.equal(openStore.mentionsName(`hi @${sixteen}, welcome`, sixteen), true);
    assert.equal(openStore.mentionsName('hi @ana, @bob and @Mary Ann!', 'mary ann'), true);
  });

  it('R12-1, R12-1b: after a restart the server answers while it indexes, and the inbox is right', async () => {
    const room = await newRoom();
    await joinHuman(room, 'x');
    const r = openStore._openRooms.get(room);
    for (let u = 1; u <= 300; u++) openStore.addMessage(r, { author: 'x', party: 'human', body: crafted(u) });
    openStore.addMessage(r, { author: 'x', party: 'human', body: 'over to you @ana' });
    const snap = JSON.parse(JSON.stringify(persist.serialize()));
    persist.restore(snap); // what boot does; indexing then runs in slices after listen
    assert.equal(openStore.mentionsIndexing(), true);
    // Other requests are answered while the index is built: no request waits on a long stretch.
    let worst = 0;
    let served = 0;
    while (openStore.mentionsIndexing()) {
      const t0 = Date.now();
      const res = await fetch(`${base}/api/open/agents`);
      assert.equal(res.status, 200);
      worst = Math.max(worst, Date.now() - t0);
      served++;
    }
    assert.ok(served > 1, `only ${served} request was served while indexing`);
    assert.ok(worst < 100, `a request waited ${worst} ms while indexing`);
    let t0 = Date.now();
    const items = openStore.inbox('ai', 'fresh-bot');
    assert.equal(items.length, 0);
    assert.ok(Date.now() - t0 < 250, `first inbox after indexing took ${Date.now() - t0} ms`);
    const ana = openStore.inbox('human', 'ana').find((i) => i.room_id === room);
    assert.equal(ana.mentions, 1);
  });

  it('R12-1b: an inbox asked for during indexing waits for it and is correct', async () => {
    const room = await newRoom();
    await joinHuman(room, 'x');
    const join = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'ana-bot', party: 'ai' });
    const r = openStore._openRooms.get(room);
    for (let u = 1; u <= 150; u++) openStore.addMessage(r, { author: 'x', party: 'human', body: crafted(u) });
    openStore.addMessage(r, { author: 'x', party: 'human', body: 'over to you @ana-bot' });
    persist.restore(JSON.parse(JSON.stringify(persist.serialize())));
    assert.equal(openStore.mentionsIndexing(), true);
    const res = await fetch(`${base}/api/open/inbox`, { headers: { Authorization: `Bearer ${join.data.credential}` } });
    assert.equal(res.status, 200);
    assert.equal(openStore.mentionsIndexing(), false);
    const item = (await res.json()).items.find((i) => i.room_id === room);
    assert.equal(item.mentions, 1);
    assert.equal(item.unread, 151);
  });
});
