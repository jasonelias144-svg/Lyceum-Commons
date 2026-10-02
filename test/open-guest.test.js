/**
 * Guest identity, tested against the /guests page line by line. Every call here sets its own
 * X-Lyceum-Guest header (or none); nothing goes through the test key jar.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const openStore = require('../src/openStore');
const notify = require('../src/notify');
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

beforeEach(() => {
  openStore.clearAll();
  notify.clearAll();
});

afterEach(() => openStore._setClock());

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

const newRoom = async (title = 'Guests') => (await json('POST', '/api/open/rooms', { title })).data.room_id;
const join = (room, handle, key) => json('POST', `/api/open/rooms/${room}/join`, { handle, party: 'human' }, key);
const post = (room, handle, body, key) => json('POST', `/api/open/rooms/${room}/post`, { handle, body }, key);
const pushSub = (endpoint) => ({ endpoint, keys: { p256dh: 'BPk3yK0test', auth: 'authsecret' } });

/** Join as a new guest and return its key. */
async function guest(room, handle) {
  const r = await join(room, handle);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.guest_key;
}

function waitFor(pred, ms = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('Joining as a guest', () => {
  it('"The first time you join, we give this browser a random guest key": once, and never again', async () => {
    const room = await newRoom();
    const first = await join(room, 'ana');
    assert.equal(first.status, 200);
    assert.match(first.data.guest_key, /^g_[A-Za-z0-9_-]{43}$/);
    const again = await join(room, 'ana', first.data.guest_key);
    assert.equal(again.status, 200);
    assert.equal(again.data.guest_key, undefined);
    const elsewhere = await join(await newRoom('Other'), 'ana-two', first.data.guest_key);
    assert.equal(elsewhere.status, 200);
    assert.equal(elsewhere.data.guest_key, undefined);
    // Two keyless joins are two different guests with two different keys.
    const other = await guest(room, 'bo');
    assert.notEqual(other, first.data.guest_key);
  });

  it('"only this browser gets to act as you": a refused join hands out no key', async () => {
    const room = await newRoom();
    await guest(room, 'ana');
    const refused = await join(room, 'ana');
    assert.equal(refused.status, 409);
    assert.equal(refused.data.guest_key, undefined);
    assert.equal(openStore._guests.size, 1);
  });

  it('an unknown or malformed key counts as no key: the join mints a fresh one', async () => {
    const room = await newRoom();
    const made = await join(room, 'ana', `g_${'A'.repeat(43)}`);
    assert.equal(made.status, 200);
    assert.match(made.data.guest_key, /^g_/);
    const odd = await join(room, 'bo', 'not-a-key');
    assert.match(odd.data.guest_key, /^g_/);
  });
});

describe('What a guest gets', () => {
  it('"Nobody else can use that name in that room while it\'s yours": no key and another key both get the generic 409', async () => {
    const room = await newRoom();
    const key = await guest(room, 'ana');
    const stranger = await guest(room, 'bo');
    const variant = await join(room, 'ANA');
    const none = await join(room, 'ana');
    const wrong = await join(room, 'ana', stranger);
    for (const r of [variant, none, wrong]) {
      assert.equal(r.status, 409);
      assert.equal(r.data.error.code, 'handle_taken');
    }
    // Nothing tells the refusals apart.
    assert.equal(none.data.error.message, wrong.data.error.message);
    assert.equal((await join(room, 'ana', key)).status, 200);
    // The name is per room: another room is free.
    assert.equal((await join(await newRoom('Two'), 'ana')).status, 200);
  });

  it('"Only you can post under that name, read the room as it, stay on its list of who\'s here, leave, or come back to it"', async () => {
    const room = await newRoom();
    const key = await guest(room, 'ana');
    const stranger = await guest(room, 'bo');
    const r = `/api/open/rooms/${room}`;
    const calls = [
      ['POST', `${r}/post`, { handle: 'ana', body: 'hello' }],
      ['POST', `${r}/heartbeat`, { handle: 'ana' }],
      ['GET', `${r}/messages?handle=ana`, undefined],
      ['POST', `${r}/state`, { handle: 'ana', state: 'dormant' }],
      ['POST', `${r}/settings`, { handle: 'ana', title: 'Renamed' }],
      ['POST', `${r}/leave`, { handle: 'ana' }],
    ];
    for (const [method, path, body] of calls) {
      const none = await json(method, path, body);
      assert.equal(none.status, 401, `${method} ${path} without a key`);
      assert.equal(none.data.error.code, 'guest_key_required');
      const wrong = await json(method, path, body, stranger);
      assert.equal(wrong.status, 403, `${method} ${path} with another key`);
      assert.equal(wrong.data.error.code, 'not_joined');
    }
    // Nothing changed: still present, still a member, room title and state as they were.
    const read = await json('GET', `${r}/messages?handle=ana`, undefined, key);
    assert.equal(read.status, 200);
    assert.equal(read.data.messages.length, 0);
    assert.equal(read.data.title, 'Guests');
    assert.ok(read.data.roster.some((p) => p.id === 'ana'));
    // With the key, every one of them works.
    for (const [method, path, body] of calls) {
      const ok = await json(method, path, body, key);
      assert.ok(ok.status === 200 || ok.status === 201, `${method} ${path} with the key: ${ok.status}`);
    }
  });

  it('a name that is not joined is still not_joined, key or no key', async () => {
    const room = await newRoom();
    const key = await guest(room, 'ana');
    const none = await post(room, 'nobody', 'hi');
    assert.equal(none.data.error.code, 'not_joined');
    const keyed = await post(room, 'nobody', 'hi', key);
    assert.equal(keyed.data.error.code, 'not_joined');
  });

  it('"Your inbox … is visible only to you": the header reads it, a handle alone does not', async () => {
    const roomA = await newRoom('A');
    const roomB = await newRoom('B');
    const ana = await guest(roomA, 'ana');
    await join(roomB, 'ana-b', ana);
    const bo = await guest(roomA, 'bo');
    await post(roomA, 'bo', 'Over to you @ana', bo);
    // Someone else called ana in a room this guest is not in.
    const otherAna = await guest(await newRoom('C'), 'ana');
    const cara = await guest(roomB, 'cara');
    await post(roomB, 'cara', 'hi all', cara);

    const byHandle = await json('GET', '/api/open/inbox?handle=ana');
    assert.equal(byHandle.status, 401);
    assert.equal(byHandle.data.error.code, 'guest_key_required');

    const mine = await json('GET', '/api/open/inbox', undefined, ana);
    assert.equal(mine.status, 200);
    const rooms = mine.data.items.map((i) => [i.room_id, i.handle]).sort();
    assert.deepEqual(rooms, [[roomA, 'ana'], [roomB, 'ana-b']].sort());
    assert.equal(mine.data.items.find((i) => i.room_id === roomA).mentions, 1);

    const theirs = await json('GET', '/api/open/inbox', undefined, otherAna);
    assert.deepEqual(theirs.data.items, []);
  });

  it('"Notifications you turn on go only to you": subscribing needs the key that holds the name', async () => {
    const room = await newRoom();
    const ana = await guest(room, 'ana');
    const bo = await guest(room, 'bo');
    const body = { room_id: room, handle: 'ana', subscription: pushSub('https://web.push.apple.com/ana') };
    const none = await json('POST', '/api/open/push/subscribe', body);
    assert.equal(none.status, 401);
    const wrong = await json('POST', '/api/open/push/subscribe', body, bo);
    assert.equal(wrong.status, 403);
    assert.equal(wrong.data.error.code, 'not_joined');
    const hook = await json('POST', '/api/open/notifications', { room_id: room, handle: 'ana', url: 'https://example.com/hook' });
    assert.equal(hook.status, 401);
    const ok = await json('POST', '/api/open/push/subscribe', body, ana);
    assert.equal(ok.status, 201);
  });

  it('a notification for a name goes only where that guest holds it, not to someone else of the same name', async () => {
    const sent = [];
    notify._setWebPushSender(async (push, payload) => {
      sent.push({ endpoint: push.endpoint, body: JSON.parse(payload) });
      return { statusCode: 201 };
    });
    const mine = await newRoom('Mine');
    const theirs = await newRoom('Theirs');
    const ana = await guest(mine, 'ana');
    const bo = await guest(mine, 'bo');
    await json('POST', '/api/open/push/subscribe', { room_id: mine, handle: 'ana', subscription: pushSub('https://web.push.apple.com/ana') }, ana);
    // A different guest, also called ana, in another room.
    await guest(theirs, 'ana');
    const cara = await guest(theirs, 'cara');
    await post(theirs, 'cara', 'Your turn @ana', cara);
    await post(mine, 'bo', 'And yours @ana', bo);
    await waitFor(() => sent.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.title, /Mine/);
  });
});

describe('The limits', () => {
  it('"If you clear site data … you come back as a new guest. Your old names stop being yours"', async () => {
    const room = await newRoom();
    await guest(room, 'ana');
    const fresh = await join(room, 'ana');
    assert.equal(fresh.status, 409);
    // The new guest can take a different name.
    assert.equal((await join(room, 'ana-again')).status, 200);
  });

  it('"A name that goes 30 days without being used is released": not at 29 days, yes after 30, and its notifications go', async () => {
    const t0 = Date.now();
    const room = await newRoom();
    const ana = await guest(room, 'ana');
    const bo = await guest(room, 'bo');
    await json('POST', '/api/open/push/subscribe', { room_id: room, handle: 'ana', subscription: pushSub('https://web.push.apple.com/ana') }, ana);
    assert.equal(notify._subscriptions.size, 1);

    openStore._setClock(() => t0 + 29 * 24 * 3600 * 1000);
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'bo', party: 'human' }, bo);
    assert.equal((await join(room, 'ana')).status, 409, 'held at 29 days, though long timed out');

    openStore._setClock(() => t0 + openStore.DEFAULT_GUEST_RELEASE_MS + 60 * 1000);
    const taken = await join(room, 'ana');
    assert.equal(taken.status, 200, 'released after 30 days');
    assert.notEqual(taken.data.guest_key, ana);
    assert.equal(notify._subscriptions.size, 0);
    // The old key no longer acts as ana.
    const old = await post(room, 'ana', 'still me?', ana);
    assert.equal(old.data.error.code, 'not_joined');
  });

  it('using a name restarts its 30 days', async () => {
    const t0 = Date.now();
    const room = await newRoom();
    const ana = await guest(room, 'ana');
    openStore._setClock(() => t0 + 20 * 24 * 3600 * 1000);
    assert.equal((await join(room, 'ana', ana)).status, 200);
    openStore._setClock(() => t0 + 45 * 24 * 3600 * 1000);
    assert.equal((await join(room, 'ana')).status, 409);
    assert.equal((await join(room, 'ana', ana)).status, 200);
  });

  it('any use counts, not only joining: a post five minutes in moves the release five minutes', async () => {
    const t0 = Date.now();
    const room = await newRoom();
    const ana = await guest(room, 'ana');
    openStore._setClock(() => t0 + 5 * 60 * 1000);
    assert.equal((await post(room, 'ana', 'still here', ana)).status, 201);
    openStore._setClock(() => t0 + openStore.DEFAULT_GUEST_RELEASE_MS + 2 * 60 * 1000);
    assert.equal((await join(room, 'ana')).status, 409);
  });
});

describe('Release window setting', () => {
  afterEach(() => delete process.env.OPEN_GUEST_RELEASE_MS);

  it('OPEN_GUEST_RELEASE_MS shortens the window for testing; bad values fall back to 30 days', async () => {
    process.env.OPEN_GUEST_RELEASE_MS = '7200000'; // two hours
    assert.equal(openStore.guestReleaseMs(), 7200000);
    const t0 = Date.now();
    const room = await newRoom();
    const bo = await guest(room, 'bo');
    await guest(room, 'ana');
    openStore._setClock(() => t0 + 7200000 + 60 * 1000);
    await json('POST', `/api/open/rooms/${room}/join`, { handle: 'bo', party: 'human' }, bo);
    assert.equal((await join(room, 'ana')).status, 200, 'released after two hours');
    for (const bad of ['59999', '2m', '-5', '1.5']) {
      process.env.OPEN_GUEST_RELEASE_MS = bad;
      assert.equal(openStore.guestReleaseMs(), openStore.DEFAULT_GUEST_RELEASE_MS, bad);
    }
  });
});

describe('What we store', () => {
  it('"A one-way fingerprint (hash) of your guest key. We don\'t keep the key itself"', async () => {
    const room = await newRoom();
    const ana = await guest(room, 'ana');
    await post(room, 'ana', 'hello', ana);
    const snap = JSON.stringify(persist.serialize());
    assert.equal(snap.includes(ana), false);
    assert.ok(snap.includes(crypto.createHash('sha256').update(ana).digest('hex')));
    const [record] = Array.from(openStore._guests.values());
    assert.equal(record.type, 'guest');
    assert.equal(record.account_id, null);
  });

  it('"We never show your key to anyone. Others in a room see the name you chose, when you joined, when you were last active"', async () => {
    const room = await newRoom();
    const ana = await guest(room, 'ana');
    const bo = await guest(room, 'bo');
    await post(room, 'ana', 'hello', ana);
    const seen = await json('GET', `/api/open/rooms/${room}/messages?handle=bo`, undefined, bo);
    const text = JSON.stringify(seen.data);
    assert.equal(text.includes(ana), false);
    assert.equal(text.includes('gst_'), false);
    const listed = JSON.stringify((await json('GET', '/api/open/rooms')).data);
    assert.equal(listed.includes(ana), false);
    assert.equal(listed.includes('gst_'), false);
  });

  it('"Notification addresses … until you turn them off, leave, or the name is released": leaving drops them', async () => {
    const room = await newRoom();
    const ana = await guest(room, 'ana');
    await json('POST', '/api/open/push/subscribe', { room_id: room, handle: 'ana', subscription: pushSub('https://web.push.apple.com/ana') }, ana);
    assert.equal(notify._subscriptions.size, 1);
    assert.equal((await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'ana' }, ana)).status, 200);
    assert.equal(notify._subscriptions.size, 0);
  });
});

describe('Memberships from before guest keys', () => {
  it('the first rejoin claims one (minting a key if it had none), and after that it is held', async () => {
    const room = await newRoom();
    const r = openStore._openRooms.get(room);
    r.members = { 'human:old-timer': true };
    // A subscription from before guest keys: scoped to the room, with no owner.
    const sub = { id: 'hook_legacy', secret: 's', party: 'human', who: 'old-timer', room_id: room, owner: null, url: 'https://example.com/hook', events: ['turn', 'mention'], enabled: true };
    notify._subscriptions.set(sub.id, sub);
    const claim = await join(room, 'old-timer');
    assert.equal(claim.status, 200);
    assert.match(claim.data.guest_key, /^g_/);
    assert.equal(notify._subscriptions.has('hook_legacy'), false, 'the old subscription is dropped, not handed to the claimer');
    assert.equal((await join(room, 'old-timer')).status, 409);
    assert.equal((await post(room, 'old-timer', 'back', claim.data.guest_key)).status, 201);
  });

  it('cannot be claimed while the name is present, with or without a key; once away, it can', async () => {
    const t0 = Date.now();
    const room = await newRoom();
    await guest(room, 'bo'); // keeps the room open
    const r = openStore._openRooms.get(room);
    r.members['human:lena'] = true;
    const at = new Date(t0).toISOString();
    r.roster.set('human:lena', { id: 'lena', party: 'human', joined_at: at, last_seen: at });
    const sub = { id: 'hook_lena', secret: 's', party: 'human', who: 'lena', room_id: room, owner: null, url: 'https://example.com/lena', events: ['turn', 'mention'], enabled: true };
    notify._subscriptions.set(sub.id, sub);
    const keyless = await join(room, 'lena');
    assert.equal(keyless.status, 409);
    assert.equal(keyless.data.error.code, 'handle_taken');
    assert.equal(keyless.data.guest_key, undefined, 'a refused claim hands out no key');
    const other = await guest(room, 'zed');
    assert.equal((await join(room, 'lena', other)).status, 409);
    assert.equal(openStore._openRooms.get(room).members['human:lena'].owner, null);
    assert.equal(sub.owner, null);
    assert.equal(notify._subscriptions.has('hook_lena'), true, 'a refused claim leaves the old subscription alone');
    openStore._setClock(() => t0 + 11 * 60 * 1000); // past the 10-minute presence TTL
    await join(room, 'bo', undefined); // any read sweeps the roster
    const claim = await join(room, 'lena');
    assert.equal(claim.status, 200, JSON.stringify(claim.data));
    assert.match(claim.data.guest_key, /^g_/);
    assert.equal(notify._subscriptions.has('hook_lena'), false);
  });
});

describe('Names per guest key', () => {
  it(`one key holds at most ${openStore.MAX_NAMES_PER_GUEST} names; the same name in more rooms counts once`, async () => {
    assert.equal(openStore.MAX_NAMES_PER_GUEST, 5);
    const rooms = [];
    for (let i = 0; i < 7; i++) rooms.push(await newRoom(`Cap ${i}`));
    const key = await guest(rooms[0], 'n0');
    for (let i = 1; i < 5; i++) assert.equal((await join(rooms[i], `n${i}`, key)).status, 200);
    const sixth = await join(rooms[5], 'n5', key);
    assert.equal(sixth.status, 403);
    assert.equal(sixth.data.error.code, 'guest_name_limit');
    assert.equal(sixth.data.guest_key, undefined);
    assert.equal((await join(rooms[5], 'n0', key)).status, 200, 'a name it already holds still works in a new room');
    assert.equal((await join(rooms[0], 'n0', key)).status, 200, 'rejoining a held name is fine');
    // Leaving every room with n4 frees a slot.
    assert.equal((await json('POST', `/api/open/rooms/${rooms[4]}/leave`, { handle: 'n4' }, key)).status, 200);
    assert.equal((await join(rooms[6], 'n6', key)).status, 200);
    // A different key is unaffected.
    assert.equal((await join(rooms[6], 'other')).status, 200);
  });
});

describe('A guest\'s name holds against AIs too', () => {
  it('an AI cannot take a guest\'s name while the guest is away, only after it is left or released', async () => {
    const t0 = Date.now();
    const room = await newRoom();
    await guest(room, 'bo'); // keeps the room open after ana leaves
    const ana = await guest(room, 'ana');
    openStore._setClock(() => t0 + 60 * 60 * 1000); // an hour away: off the roster, still holding the name
    const ai = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'ana', party: 'ai' });
    assert.equal(ai.status, 403);
    assert.equal(ai.data.error.code, 'invalid_party');
    assert.equal((await join(room, 'ana', ana)).status, 200, 'the guest comes back to it');
    await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'ana' }, ana);
    const after = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'ana', party: 'ai' });
    assert.equal(after.status, 200);
  });
});

describe('Unchanged for AIs', () => {
  it('AI join, post and read use the Bearer and never a guest key', async () => {
    const room = await newRoom();
    const ai = await json('POST', `/api/open/rooms/${room}/join`, { agent_id: 'claude-x', party: 'ai' });
    assert.equal(ai.status, 200);
    assert.equal(ai.data.guest_key, undefined);
    const res = await fetch(`${base}/api/open/rooms/${room}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.data.credential}` },
      body: JSON.stringify({ body: 'hi' }),
    });
    assert.equal(res.status, 201);
    assert.equal(openStore._guests.size, 0);
  });
});
