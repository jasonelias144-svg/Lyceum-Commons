/**
 * Open join identity: a present AI's credential is never handed to another join (RR2), and
 * one name per participant per room regardless of case or party (RR3). Also checks that the
 * MCP endpoint (authenticated by its connector key) still re-joins its agent.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const openStore = require('../src/openStore');

const MCP_KEY = 'rr2-test-key-0123456789abcdef00';
const TTL = openStore.DEFAULT_PRESENCE_TTL_MS;
const MIN = 60 * 1000;

let server;
let base;
let t;

before(async () => {
  process.env.LYCEUM_MCP_KEYS = `mcp-bot=${MCP_KEY}`;
  const app = require('../src/server');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  delete process.env.LYCEUM_MCP_KEYS;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  openStore._setClock();
  openStore.clearAll();
  t = Date.now();
  openStore._setClock(() => t);
});

afterEach(() => openStore._setClock());

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function newRoom() {
  return (await json('POST', '/api/open/rooms', { title: 'Identity' })).data.room_id;
}

const joinAi = (room, agent_id, headers) => json('POST', `/api/open/rooms/${room}/join`, { agent_id, party: 'ai' }, headers);
const joinHuman = (room, handle) => json('POST', `/api/open/rooms/${room}/join`, { handle, party: 'human' });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('RR2: a present AI keeps its credential to itself', () => {
  it('a second join as a present AI gets 409 handle_taken and never sees the token', async () => {
    const room = await newRoom();
    const first = await joinAi(room, 'victim-bot');
    assert.equal(first.status, 200);
    const token = first.data.credential;
    assert.ok(token);

    const second = await joinAi(room, 'victim-bot');
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'handle_taken');
    assert.equal(second.data.credential, undefined);
    assert.doesNotMatch(JSON.stringify(second.data), new RegExp(token));

    // A wrong or unrelated Bearer is no better.
    const other = await joinAi(room, 'other-bot');
    for (const h of [bearer('not-a-real-token'), bearer(other.data.credential)]) {
      const r = await joinAi(room, 'victim-bot', h);
      assert.equal(r.status, 409);
      assert.equal(r.data.credential, undefined);
    }
    // The real agent is unaffected.
    const post = await json('POST', `/api/open/rooms/${room}/post`, { body: 'still me' }, bearer(token));
    assert.equal(post.status, 201);
    assert.equal(post.data.message.author, 'victim-bot');
  });

  it('a re-join with its own valid Bearer succeeds and keeps the same token and membership', async () => {
    const room = await newRoom();
    const first = await joinAi(room, 'steady-bot');
    t += 5 * MIN;
    const again = await joinAi(room, 'steady-bot', bearer(first.data.credential));
    assert.equal(again.status, 200);
    assert.equal(again.data.credential, first.data.credential);
    assert.equal(again.data.roster.filter((p) => p.id === 'steady-bot').length, 1);
    assert.equal(again.data.roster.find((p) => p.id === 'steady-bot').last_seen, new Date(t).toISOString());
  });

  it('an expired AI joins fresh with a new token; its old token is 401', async () => {
    const room = await newRoom();
    await joinHuman(room, 'keeper');
    const first = await joinAi(room, 'sleepy-bot');
    t += TTL / 2;
    await json('POST', `/api/open/rooms/${room}/heartbeat`, { handle: 'keeper' });
    t += TTL / 2 + MIN;
    const fresh = await joinAi(room, 'sleepy-bot');
    assert.equal(fresh.status, 200);
    assert.ok(fresh.data.credential);
    assert.notEqual(fresh.data.credential, first.data.credential);
    const old = await json('POST', `/api/open/rooms/${room}/post`, { body: 'zombie' }, bearer(first.data.credential));
    assert.equal(old.status, 401);
    const now = await json('POST', `/api/open/rooms/${room}/post`, { body: 'back' }, bearer(fresh.data.credential));
    assert.equal(now.status, 201);
  });

  it('an AI that left joins fresh', async () => {
    const room = await newRoom();
    await joinHuman(room, 'keeper');
    const first = await joinAi(room, 'leaving-bot');
    await json('POST', `/api/open/rooms/${room}/leave`, {}, bearer(first.data.credential));
    const back = await joinAi(room, 'leaving-bot');
    assert.equal(back.status, 200);
    assert.notEqual(back.data.credential, first.data.credential);
  });

  it('a human join of a present handle leaks no credential (humans have none)', async () => {
    const room = await newRoom();
    await joinHuman(room, 'ada');
    await joinAi(room, 'ada-bot');
    const again = await joinHuman(room, 'ada');
    assert.equal(again.status, 200);
    assert.equal(again.data.credential, undefined);
    assert.doesNotMatch(JSON.stringify(again.data), /credential/);
  });
});

describe('RR2: MCP re-join still works', () => {
  async function connect() {
    const client = new Client({ name: 'rr2-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?key=${MCP_KEY}`)));
    return client;
  }
  async function call(client, name, args) {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  }

  it('an MCP agent that timed out is re-joined on its next post; a web join cannot take its token', async () => {
    const room = await newRoom();
    await joinHuman(room, 'keeper');
    const client = await connect();
    try {
      let r = await call(client, 'post_message', { room_id: room, body: 'first' });
      assert.equal(r.isError, false);
      assert.equal((await joinAi(room, 'mcp-bot')).status, 409);

      t += TTL / 2;
      await json('POST', `/api/open/rooms/${room}/heartbeat`, { handle: 'keeper' });
      t += TTL / 2 + MIN;
      const read = await json('GET', `/api/open/rooms/${room}/messages?handle=keeper`);
      assert.deepEqual(read.data.roster.map((p) => p.id), ['keeper']);

      r = await call(client, 'post_message', { room_id: room, body: 'second' });
      assert.equal(r.isError, false);
      const after = await json('GET', `/api/open/rooms/${room}/messages?handle=keeper`);
      assert.deepEqual(after.data.roster.map((p) => `${p.party}:${p.id}`).sort(), ['ai:mcp-bot', 'human:keeper']);
      assert.equal(after.data.messages[1].author, 'mcp-bot');
    } finally {
      await client.close();
    }
  });

  it('an MCP agent whose name is held by a case variant gets a clear tool error', async () => {
    const room = await newRoom();
    await joinHuman(room, 'MCP-Bot');
    const client = await connect();
    try {
      const r = await call(client, 'post_message', { room_id: room, body: 'hello' });
      assert.equal(r.isError, true);
      assert.match(r.text, /Cannot join as mcp-bot/);
    } finally {
      await client.close();
    }
  });
});

describe('RR3: one name per participant, regardless of case or party', () => {
  it('case variants in the same party get 409 handle_taken; the first display case is kept', async () => {
    const room = await newRoom();
    await joinAi(room, 'qa-bot');
    const ai = await joinAi(room, 'QA-BOT');
    assert.equal(ai.status, 409);
    assert.equal(ai.data.error.code, 'handle_taken');
    assert.equal(ai.data.credential, undefined);

    await joinHuman(room, 'Jason');
    const human = await joinHuman(room, 'jason');
    assert.equal(human.status, 409);
    assert.equal(human.data.error.code, 'handle_taken');

    const read = await json('GET', `/api/open/rooms/${room}/messages?handle=Jason`);
    assert.deepEqual(read.data.roster.map((p) => p.id).sort(), ['Jason', 'qa-bot']);
  });

  it('case variants across parties get 409; the exact name as the other party is invalid_party', async () => {
    const room = await newRoom();
    await joinHuman(room, 'x');
    const variant = await joinAi(room, 'X');
    assert.equal(variant.status, 409);
    assert.equal(variant.data.error.code, 'handle_taken');
    const exact = await joinAi(room, 'x');
    assert.equal(exact.status, 403);
    assert.equal(exact.data.error.code, 'invalid_party');

    await joinAi(room, 'Nova');
    assert.equal((await joinHuman(room, 'nova')).status, 409);
    assert.equal((await joinHuman(room, 'Nova')).data.error.code, 'invalid_party');
  });

  it('a kept (expired) member holds its name too', async () => {
    const room = await newRoom();
    await joinHuman(room, 'keeper');
    await joinHuman(room, 'qa-k');
    t += TTL / 2;
    await json('POST', `/api/open/rooms/${room}/heartbeat`, { handle: 'keeper' });
    t += TTL / 2 + MIN;
    const read = await json('GET', `/api/open/rooms/${room}/messages?handle=keeper`);
    assert.deepEqual(read.data.roster.map((p) => p.id), ['keeper']);
    assert.equal((await joinHuman(room, 'QA-K')).status, 409);
    assert.equal((await joinAi(room, 'qa-K')).status, 409);
    // The member itself rejoins as before.
    assert.equal((await joinHuman(room, 'qa-k')).status, 200);
  });

  it('a same-case rejoin is unaffected; a name freed by leave can be taken in any case', async () => {
    const room = await newRoom();
    const first = await joinHuman(room, 'ada');
    assert.equal(first.status, 200);
    const again = await joinHuman(room, 'ada');
    assert.equal(again.status, 200);
    assert.equal(again.data.roster.length, 1);
    await joinHuman(room, 'keeper');
    await json('POST', `/api/open/rooms/${room}/leave`, { handle: 'ada' });
    assert.equal((await joinHuman(room, 'ADA')).status, 200);
  });

  it('duplicates restored from an older snapshot can both still rejoin', async () => {
    const lobby = openStore._openRooms.get('open-welcome');
    const at = new Date(t).toISOString();
    lobby.roster.set('human:jason', { id: 'jason', party: 'human', joined_at: at, last_seen: at });
    lobby.roster.set('human:Jason', { id: 'Jason', party: 'human', joined_at: at, last_seen: at });
    assert.equal((await joinHuman('open-welcome', 'jason')).status, 200);
    assert.equal((await joinHuman('open-welcome', 'Jason')).status, 200);
    assert.equal((await joinHuman('open-welcome', 'JASON')).status, 409);
  });
});
