/**
 * Open composition API tests — mixed human+ai join/post/list/leave,
 * cross-pose refuse, party forced on post, store separation from Human/AI.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const aiStore = require('../src/aiStore');
const openStore = require('../src/openStore');

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
  aiStore.clearAll();
  openStore.clearAll();
});

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('Open happy path — mixed parties', () => {
  it('create → human join → ai join → both post → list labeled → leave', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    assert.equal(created.status, 201);
    assert.ok(created.data.room_id);
    assert.equal(created.data.layer, 'open');
    const roomId = created.data.room_id;

    const hj = await json('POST', `/api/open/rooms/${roomId}/join`, {
      handle: 'Alex',
      party: 'human',
    });
    assert.equal(hj.status, 200);
    assert.equal(hj.data.layer, 'open');
    assert.equal(hj.data.roster.length, 1);
    assert.equal(hj.data.roster[0].id, 'Alex');
    assert.equal(hj.data.roster[0].party, 'human');
    assert.equal(hj.data.credential, undefined);

    const aj = await json('POST', `/api/open/rooms/${roomId}/join`, {
      agent_id: 'bot-1',
      party: 'ai',
    });
    assert.equal(aj.status, 200);
    assert.ok(aj.data.credential);
    assert.equal(aj.data.roster.length, 2);
    const parties = aj.data.roster.map((r) => r.party).sort();
    assert.deepEqual(parties, ['ai', 'human']);

    const hp = await json('POST', `/api/open/rooms/${roomId}/post`, {
      handle: 'Alex',
      body: 'hello from a person',
    });
    assert.equal(hp.status, 201);
    assert.equal(hp.data.message.party, 'human');
    assert.equal(hp.data.message.author, 'Alex');
    assert.equal(hp.data.message.room_id, roomId);

    const ap = await json(
      'POST',
      `/api/open/rooms/${roomId}/post`,
      { body: 'hello from a machine' },
      { Authorization: `Bearer ${aj.data.credential}` }
    );
    assert.equal(ap.status, 201);
    assert.equal(ap.data.message.party, 'ai');
    assert.equal(ap.data.message.author, 'bot-1');

    const list = await json(
      'GET',
      `/api/open/rooms/${roomId}/messages?handle=Alex`
    );
    assert.equal(list.status, 200);
    assert.equal(list.data.messages.length, 2);
    assert.equal(list.data.messages[0].party, 'human');
    assert.equal(list.data.messages[1].party, 'ai');
    assert.equal(list.data.roster.length, 2);
    assert.equal(list.data.layer, 'open');

    const listAi = await json(
      'GET',
      `/api/open/rooms/${roomId}/messages`,
      undefined,
      { Authorization: `Bearer ${aj.data.credential}` }
    );
    assert.equal(listAi.status, 200);
    assert.equal(listAi.data.messages.length, 2);

    const leaveH = await json('POST', `/api/open/rooms/${roomId}/leave`, {
      handle: 'Alex',
    });
    assert.equal(leaveH.status, 200);
    assert.equal(leaveH.data.ok, true);
    assert.equal(leaveH.data.roster.length, 1);
    assert.equal(leaveH.data.roster[0].party, 'ai');

    const leaveA = await json(
      'POST',
      `/api/open/rooms/${roomId}/leave`,
      {},
      { Authorization: `Bearer ${aj.data.credential}` }
    );
    assert.equal(leaveA.status, 200);
    assert.equal(leaveA.data.ok, true);
  });

  it('open-welcome lobby exists and accepts mixed join', async () => {
    const hj = await json('POST', '/api/open/rooms/open-welcome/join', {
      handle: 'Sam',
      party: 'human',
    });
    assert.equal(hj.status, 200);
    assert.equal(hj.data.room_id, 'open-welcome');

    const aj = await json('POST', '/api/open/rooms/open-welcome/join', {
      agent_id: 'lobby-bot',
      party: 'ai',
    });
    assert.equal(aj.status, 200);
    assert.ok(aj.data.credential);
    assert.equal(aj.data.roster.length, 2);
  });

  it('re-join same human is idempotent; ai re-join returns credential', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const roomId = created.data.room_id;
    await json('POST', `/api/open/rooms/${roomId}/join`, {
      handle: 'Ada',
      party: 'human',
    });
    const again = await json('POST', `/api/open/rooms/${roomId}/join`, {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.roster.length, 1);

    const aj = await json('POST', `/api/open/rooms/${roomId}/join`, {
      agent_id: 'rejoin-bot',
      party: 'ai',
    });
    const aj2 = await json('POST', `/api/open/rooms/${roomId}/join`, {
      agent_id: 'rejoin-bot',
      party: 'ai',
    });
    assert.equal(aj2.data.credential, aj.data.credential);
    assert.equal(aj2.data.roster.length, 2);
  });

  it('party forced on post — client cannot choose party', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const roomId = created.data.room_id;
    await json('POST', `/api/open/rooms/${roomId}/join`, {
      handle: 'Alex',
      party: 'human',
    });
    // Even if client sends party ai with handle only (no bearer) → invalid_party
    const bad = await json('POST', `/api/open/rooms/${roomId}/post`, {
      handle: 'Alex',
      body: 'try to be ai',
      party: 'ai',
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.data.error.code, 'invalid_party');

    const ok = await json('POST', `/api/open/rooms/${roomId}/post`, {
      handle: 'Alex',
      body: 'still human',
      party: 'human',
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.message.party, 'human');
  });
});

describe('Open cross-pose refuse', () => {
  it('human handle + party ai → invalid_party', async () => {
    const res = await json('POST', '/api/open/rooms/open-welcome/join', {
      handle: 'Alex',
      party: 'ai',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'invalid_party');
  });

  it('agent_id + party human → invalid_party', async () => {
    const res = await json('POST', '/api/open/rooms/open-welcome/join', {
      agent_id: 'bot-1',
      party: 'human',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'invalid_party');
  });

  it('post as human using AI bearer → invalid_party', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const roomId = created.data.room_id;
    const aj = await json('POST', `/api/open/rooms/${roomId}/join`, {
      agent_id: 'bot-1',
      party: 'ai',
    });
    const res = await json(
      'POST',
      `/api/open/rooms/${roomId}/post`,
      { handle: 'Alex', body: 'pose', party: 'human' },
      { Authorization: `Bearer ${aj.data.credential}` }
    );
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'invalid_party');
  });

  it('post with AI bearer claiming party human only → invalid_party', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const roomId = created.data.room_id;
    const aj = await json('POST', `/api/open/rooms/${roomId}/join`, {
      agent_id: 'bot-1',
      party: 'ai',
    });
    const res = await json(
      'POST',
      `/api/open/rooms/${roomId}/post`,
      { body: 'pose', party: 'human' },
      { Authorization: `Bearer ${aj.data.credential}` }
    );
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'invalid_party');
  });

  it('join with AI bearer + party human → invalid_party', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const roomId = created.data.room_id;
    const aj = await json('POST', `/api/open/rooms/${roomId}/join`, {
      agent_id: 'bot-1',
      party: 'ai',
    });
    const res = await json(
      'POST',
      `/api/open/rooms/${roomId}/join`,
      { handle: 'Alex', party: 'human' },
      { Authorization: `Bearer ${aj.data.credential}` }
    );
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'invalid_party');
  });

  it('illegal party string → invalid_party', async () => {
    const res = await json('POST', '/api/open/rooms/open-welcome/join', {
      handle: 'Alex',
      party: 'cyborg',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'invalid_party');
  });
});

describe('Open caps and validation', () => {
  it('soft cap 16 → room_full', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const roomId = created.data.room_id;
    for (let i = 0; i < 16; i++) {
      const r = await json('POST', `/api/open/rooms/${roomId}/join`, {
        handle: `H${i}`,
        party: 'human',
      });
      assert.equal(r.status, 200);
    }
    const over = await json('POST', `/api/open/rooms/${roomId}/join`, {
      agent_id: 'overflow-bot',
      party: 'ai',
    });
    assert.equal(over.status, 403);
    assert.equal(over.data.error.code, 'room_full');
  });

  it('empty / oversize body → invalid_body', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const roomId = created.data.room_id;
    await json('POST', `/api/open/rooms/${roomId}/join`, {
      handle: 'Alex',
      party: 'human',
    });
    const empty = await json('POST', `/api/open/rooms/${roomId}/post`, {
      handle: 'Alex',
      body: '   ',
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error.code, 'invalid_body');

    const big = await json('POST', `/api/open/rooms/${roomId}/post`, {
      handle: 'Alex',
      body: 'x'.repeat(4001),
    });
    assert.equal(big.status, 400);
    assert.equal(big.data.error.code, 'invalid_body');
  });

  it('post without join → not_joined', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    const res = await json('POST', `/api/open/rooms/${created.data.room_id}/post`, {
      handle: 'Ghost',
      body: 'hi',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_joined');
  });

  it('leave if absent is no-op ok', async () => {
    const created = await json('POST', '/api/open/rooms', {});
    // join someone so room is not GC'd immediately... actually leave absent on empty room
    await json('POST', `/api/open/rooms/${created.data.room_id}/join`, {
      handle: 'Keeper',
      party: 'human',
    });
    const res = await json('POST', `/api/open/rooms/${created.data.room_id}/leave`, {
      handle: 'NeverJoined',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.roster.length, 1);
  });
});

describe('Human/AI APIs still refuse opposite; Open rooms invisible', () => {
  it('Human API still refuses party ai', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const res = await json('POST', `/api/human/rooms/${created.room_id}/join`, {
      handle: 'Bot',
      party: 'ai',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_human');
  });

  it('AI API still refuses party human', async () => {
    const res = await json('POST', '/api/ai/rooms', {
      agent_id: 'probe',
      party: 'human',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_ai');
  });

  it('Open rooms invisible to Human and AI APIs; stores stay separate', async () => {
    const open = await json('POST', '/api/open/rooms', {});
    const openId = open.data.room_id;
    assert.ok(openStore.getRoom(openId));
    assert.equal(store.getRoom(openId), null);
    assert.equal(aiStore.getRoom(openId), null);

    const peekH = await json('POST', `/api/human/rooms/${openId}/join`, {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(peekH.status, 404);
    assert.equal(peekH.data.error.code, 'room_not_found');

    const peekA = await json('POST', `/api/ai/rooms/${openId}/join`, {
      agent_id: 'x',
      party: 'ai',
    });
    assert.equal(peekA.status, 404);
    assert.equal(peekA.data.error.code, 'room_not_found');

    // Human welcome invisible to Open
    const peekO = await json('POST', '/api/open/rooms/welcome/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(peekO.status, 404);
    assert.equal(peekO.data.error.code, 'room_not_found');

    // ai-welcome invisible to Open
    const peekO2 = await json('POST', '/api/open/rooms/ai-welcome/join', {
      agent_id: 'x',
      party: 'ai',
    });
    assert.equal(peekO2.status, 404);
    assert.equal(peekO2.data.error.code, 'room_not_found');

    // open-welcome invisible to Human/AI
    const peekHW = await json('POST', '/api/human/rooms/open-welcome/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(peekHW.status, 404);
    const peekAW = await json('POST', '/api/ai/rooms/open-welcome/join', {
      agent_id: 'x',
      party: 'ai',
    });
    assert.equal(peekAW.status, 404);
  });
});

describe('Open page honesty', () => {
  it('/open is live composition UI, no Ask-AI chrome', async () => {
    const text = await (await fetch(`${base}/open`)).text();
    assert.match(text, /composition of Human and AI streams/i);
    assert.match(text, /Parties stay labeled/i);
    assert.match(text, /open-welcome/);
    assert.match(text, /id="btn-join"/);
    assert.match(text, /id="compose"/);
    assert.doesNotMatch(text, /Not open yet/i);
    assert.doesNotMatch(text, /Join surface not open yet/i);
    assert.doesNotMatch(text, /\bAsk AI\b/i);
    assert.doesNotMatch(text, /assistant sidebar/i);
    assert.doesNotMatch(text, /chat with AI/i);
  });

  it('home door shows Open Live with composition promise', async () => {
    const text = await (await fetch(`${base}/`)).text();
    assert.match(text, /data-room="open"/);
    assert.match(text, /Where Human and AI streams meet/);
    assert.match(text, />Live</);
    assert.doesNotMatch(text, /Not open yet/);
  });
});

describe('Open turn states and inbox', () => {
  it('human hands the turn to an AI; AI reply clears it; inbox follows', async () => {
    const room = (await json('POST', '/api/open/rooms', { title: 'Turns' })).data;
    const roomId = room.room_id || room.room.id || room.id;
    await json('POST', `/api/open/rooms/${roomId}/join`, { handle: 'jason', party: 'human' });
    const ai = await json('POST', `/api/open/rooms/${roomId}/join`, { agent_id: 'claude-x', party: 'ai' });
    const auth = { Authorization: `Bearer ${ai.data.credential}` };

    const post = await json('POST', `/api/open/rooms/${roomId}/post`, {
      handle: 'jason',
      body: 'Over to you.',
      awaiting: ['claude-x'],
    });
    assert.equal(post.status, 201);
    assert.deepEqual(post.data.turn.awaiting, ['claude-x']);
    assert.equal(post.data.turn.state, 'input-required');

    const aiInbox = await json('GET', '/api/open/inbox', undefined, auth);
    assert.equal(aiInbox.data.items.length, 1);
    assert.equal(aiInbox.data.items[0].your_turn, true);

    const reply = await json('POST', `/api/open/rooms/${roomId}/post`, { body: 'Here.' }, auth);
    assert.equal(reply.data.turn.state, 'open');

    const humanInbox = await json('GET', '/api/open/inbox?handle=jason');
    assert.equal(humanInbox.data.items[0].unread, 1);
    await json('GET', `/api/open/rooms/${roomId}/messages?handle=jason`);
    assert.equal((await json('GET', '/api/open/inbox?handle=jason')).data.items.length, 0);
  });

  it('state endpoint sets dormant; bad input is refused', async () => {
    await json('POST', '/api/open/rooms/open-welcome/join', { handle: 'jason', party: 'human' });
    const ok = await json('POST', '/api/open/rooms/open-welcome/state', {
      handle: 'jason',
      state: 'dormant',
      note: 'resting',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.turn.state, 'dormant');
    const bad = await json('POST', '/api/open/rooms/open-welcome/state', { handle: 'jason', state: 'asleep' });
    assert.equal(bad.status, 400);
    const noAwait = await json('POST', '/api/open/rooms/open-welcome/state', {
      handle: 'jason',
      state: 'input-required',
    });
    assert.equal(noAwait.status, 400);
    const badAwait = await json('POST', '/api/open/rooms/open-welcome/post', {
      handle: 'jason',
      body: 'hi',
      awaiting: 'claude',
    });
    assert.equal(badAwait.status, 400);
  });
});
