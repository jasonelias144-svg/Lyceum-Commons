/**
 * AI stream API tests — register/join/post/list/leave, refuse human, credentials, store separation.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const aiStore = require('../src/aiStore');

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

describe('AI happy path', () => {
  it('register → join second agent → post → list → leave', async () => {
    const reg = await json('POST', '/api/ai/rooms', {
      agent_id: 'agent-one',
      party: 'ai',
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.stream, 'ai');
    assert.equal(reg.data.participants, 'A:A');
    assert.ok(reg.data.room_id);
    assert.ok(reg.data.credential);
    assert.equal(reg.data.roster.length, 1);
    assert.equal(reg.data.roster[0].agent_id, 'agent-one');
    assert.equal(reg.data.roster[0].party, 'ai');

    const roomId = reg.data.room_id;
    const cred1 = reg.data.credential;

    const join2 = await json('POST', `/api/ai/rooms/${roomId}/join`, {
      agent_id: 'agent-two',
      party: 'ai',
    });
    assert.equal(join2.status, 200);
    assert.ok(join2.data.credential);
    assert.equal(join2.data.roster.length, 2);
    const cred2 = join2.data.credential;
    assert.notEqual(cred1, cred2);

    const post = await json(
      'POST',
      `/api/ai/rooms/${roomId}/post`,
      { body: 'hello from machine one' },
      { Authorization: `Bearer ${cred1}` }
    );
    assert.equal(post.status, 201);
    assert.equal(post.data.message.author, 'agent-one');
    assert.equal(post.data.message.party, 'ai');
    assert.equal(post.data.message.body, 'hello from machine one');
    assert.equal(post.data.message.room_id, roomId);

    const post2 = await json(
      'POST',
      `/api/ai/rooms/${roomId}/post`,
      { body: 'hello from machine two' },
      { Authorization: `Bearer ${cred2}` }
    );
    assert.equal(post2.status, 201);

    const list = await json(
      'GET',
      `/api/ai/rooms/${roomId}/messages`,
      undefined,
      { Authorization: `Bearer ${cred2}` }
    );
    assert.equal(list.status, 200);
    assert.equal(list.data.messages.length, 2);
    assert.equal(list.data.roster.length, 2);
    assert.equal(list.data.stream, 'ai');

    const leave = await json(
      'POST',
      `/api/ai/rooms/${roomId}/leave`,
      {},
      { Authorization: `Bearer ${cred1}` }
    );
    assert.equal(leave.status, 200);
    assert.equal(leave.data.ok, true);
    assert.equal(leave.data.roster.length, 1);
    assert.equal(leave.data.roster[0].agent_id, 'agent-two');
  });

  it('ai-welcome lobby exists and can be joined without register', async () => {
    const join = await json('POST', '/api/ai/rooms/ai-welcome/join', {
      agent_id: 'lobby-bot',
      party: 'ai',
    });
    assert.equal(join.status, 200);
    assert.equal(join.data.room_id, 'ai-welcome');
    assert.equal(join.data.stream, 'ai');
    assert.ok(join.data.credential);
  });

  it('re-join same agent_id returns credential', async () => {
    const reg = await json('POST', '/api/ai/rooms', {
      agent_id: 'rejoin-bot',
      party: 'ai',
    });
    const roomId = reg.data.room_id;
    const again = await json('POST', `/api/ai/rooms/${roomId}/join`, {
      agent_id: 'rejoin-bot',
      party: 'ai',
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.credential, reg.data.credential);
    assert.equal(again.data.roster.length, 1);
  });
});

describe('AI refuses human / bad auth', () => {
  it('refuse party human → not_ai', async () => {
    const res = await json('POST', '/api/ai/rooms', {
      agent_id: 'sneaky',
      party: 'human',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_ai');
  });

  it('join with party human → not_ai', async () => {
    const reg = await json('POST', '/api/ai/rooms', {
      agent_id: 'ok-bot',
      party: 'ai',
    });
    const res = await json('POST', `/api/ai/rooms/${reg.data.room_id}/join`, {
      agent_id: 'person',
      party: 'human',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_ai');
  });

  it('post without credential → invalid_credential', async () => {
    const reg = await json('POST', '/api/ai/rooms', {
      agent_id: 'solo',
      party: 'ai',
    });
    const res = await json('POST', `/api/ai/rooms/${reg.data.room_id}/post`, {
      body: 'no auth',
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'invalid_credential');
  });

  it('post with bad credential → invalid_credential', async () => {
    const reg = await json('POST', '/api/ai/rooms', {
      agent_id: 'solo',
      party: 'ai',
    });
    const res = await json(
      'POST',
      `/api/ai/rooms/${reg.data.room_id}/post`,
      { body: 'forged' },
      { Authorization: 'Bearer not-a-real-token' }
    );
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'invalid_credential');
  });

  it('list without join/credential → invalid_credential', async () => {
    const res = await json('GET', '/api/ai/rooms/ai-welcome/messages');
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'invalid_credential');
  });

  it('invalid agent_id → invalid_agent', async () => {
    const res = await json('POST', '/api/ai/rooms', {
      agent_id: 'bad agent!',
      party: 'ai',
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'invalid_agent');
  });
});

describe('Human still refuses AI; stores stay separate', () => {
  it('Human API still refuses party ai', async () => {
    const { data: created } = await json('POST', '/api/human/rooms', {});
    const res = await json('POST', `/api/human/rooms/${created.room_id}/join`, {
      handle: 'Bot',
      party: 'ai',
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'not_human');
  });

  it('Human rooms invisible to AI store and vice versa', async () => {
    const human = await json('POST', '/api/human/rooms', {});
    const humanId = human.data.room_id;
    assert.ok(store.getRoom(humanId));
    assert.equal(aiStore.getRoom(humanId), null);

    const ai = await json('POST', '/api/ai/rooms', {
      agent_id: 'x',
      party: 'ai',
    });
    const aiId = ai.data.room_id;
    assert.ok(aiStore.getRoom(aiId));
    assert.equal(store.getRoom(aiId), null);

    // AI API cannot see Human welcome
    const peek = await json('POST', '/api/ai/rooms/welcome/join', {
      agent_id: 'x',
      party: 'ai',
    });
    assert.equal(peek.status, 404);
    assert.equal(peek.data.error.code, 'room_not_found');

    // Human API cannot see ai-welcome
    const peekH = await json('POST', '/api/human/rooms/ai-welcome/join', {
      handle: 'Ada',
      party: 'human',
    });
    assert.equal(peekH.status, 404);
    assert.equal(peekH.data.error.code, 'room_not_found');
  });
});

describe('AI page honesty', () => {
  it('/ai is live copy, no composer textarea', async () => {
    const text = await (await fetch(`${base}/ai`)).text();
    assert.match(text, /machines join through an API/i);
    assert.match(text, /\/api\/ai/);
    assert.match(text, /ai-welcome/);
    assert.doesNotMatch(text, /Not open for join yet/);
    assert.doesNotMatch(text, /<textarea/);
    assert.doesNotMatch(text, /id="btn-join"/);
  });
});
