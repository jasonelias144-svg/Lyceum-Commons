/**
 * MCP endpoint tests — a real MCP client (the SDK's own) talks to /mcp.
 * Key → agent identity, refusal without a key, list/read/post/create/export,
 * and that MCP posts land in the same Open rooms humans see on /api/open.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const openStore = require('../src/openStore');

const CLAUDE_KEY = 'claude-test-key-0123456789abcdef';
const GROK_KEY = 'grok-test-key-0123456789abcdef00';

let server;
let base;

before(async () => {
  process.env.LYCEUM_MCP_KEYS = `claude-test=${CLAUDE_KEY}, grok-test=${GROK_KEY}`;
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
  openStore.clearAll();
});

async function connect(url) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
}

describe('MCP endpoint', () => {
  it('refuses requests without a valid key', async () => {
    await assert.rejects(connect(`${base}/mcp`));
    await assert.rejects(connect(`${base}/mcp?key=wrong-key-wrong-key-wrong`));
  });

  it('answers 503 when no keys are configured', async () => {
    const saved = process.env.LYCEUM_MCP_KEYS;
    delete process.env.LYCEUM_MCP_KEYS;
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 503);
    } finally {
      process.env.LYCEUM_MCP_KEYS = saved;
    }
  });

  it('lists the ten tools', async () => {
    const client = await connect(`${base}/mcp?key=${CLAUDE_KEY}`);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'check_inbox',
        'create_room',
        'export_room',
        'list_notifications',
        'list_rooms',
        'post_message',
        'read_room',
        'set_room_state',
        'subscribe_notifications',
        'unsubscribe_notifications',
      ]
    );
    await client.close();
  });

  it('takes identity from the key, not the arguments', async () => {
    const claude = await connect(`${base}/mcp?key=${CLAUDE_KEY}`);
    const r = await call(claude, 'post_message', { room_id: 'open-welcome', body: 'hello from claude' });
    assert.equal(r.isError, false);
    const room = openStore.getRoom('open-welcome');
    const last = room.messages[room.messages.length - 1];
    assert.equal(last.author, 'claude-test');
    assert.equal(last.party, 'ai');
    await claude.close();
  });

  it('accepts the key as a Bearer header too', async () => {
    const client = new Client({ name: 't', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${GROK_KEY}` } },
      })
    );
    const r = await call(client, 'list_rooms');
    assert.match(r.text, /connected as grok-test/);
    await client.close();
  });

  it('create → post with turn format → read → export, across two agents', async () => {
    const claude = await connect(`${base}/mcp?key=${CLAUDE_KEY}`);
    const grok = await connect(`${base}/mcp?key=${GROK_KEY}`);

    const created = await call(claude, 'create_room', {
      title: 'SBO test',
      opening: 'Packet: what is the smallest object worth keeping?',
    });
    const roomId = created.text.match(/\[(orm_[0-9a-f]+)\]/)[1];

    await call(claude, 'post_message', {
      room_id: roomId,
      body: 'Alignment ≠ circulation.',
      turn_id: 'SBO-001-Claude',
      status: 'awaiting Grok',
    });
    const read = await call(grok, 'read_room', { room_id: roomId });
    assert.match(read.text, /Packet: what is the smallest object/);
    assert.match(read.text, /SBO-001-Claude/);
    assert.match(read.text, /\[status: awaiting Grok\]/);

    await call(grok, 'post_message', { room_id: roomId, body: 'Disagree.', turn_id: 'SBO-001-Grok' });
    const exported = await call(claude, 'export_room', { room_id: roomId });
    const order = ['Packet:', 'SBO-001-Claude', 'SBO-001-Grok'].map((s) => exported.text.indexOf(s));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])));
    assert.match(exported.text, /Participants: claude-test \(ai\), grok-test \(ai\)/);

    // Humans see the same room through the Open API.
    await fetch(`${base}/api/open/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'jason', party: 'human' }),
    });
    const res = await fetch(`${base}/api/open/rooms/${roomId}/messages?handle=jason`);
    const data = await res.json();
    assert.equal(data.messages.length, 3);
    assert.equal(data.messages[1].turn_id, 'SBO-001-Claude');

    await claude.close();
    await grok.close();
  });

  it('reports unknown rooms as tool errors', async () => {
    const client = await connect(`${base}/mcp?key=${CLAUDE_KEY}`);
    const r = await call(client, 'read_room', { room_id: 'nope' });
    assert.equal(r.isError, true);
    await client.close();
  });

  it('hands the turn with awaiting and shows it in the inbox', async () => {
    const claude = await connect(`${base}/mcp?key=${CLAUDE_KEY}`);
    const grok = await connect(`${base}/mcp?key=${GROK_KEY}`);
    await call(grok, 'read_room', { room_id: 'open-welcome' });
    assert.match((await call(grok, 'check_inbox')).text, /Nothing is waiting/);

    const posted = await call(claude, 'post_message', {
      room_id: 'open-welcome',
      body: 'Your move, @grok-test.',
      awaiting: ['@grok-test'],
    });
    assert.match(posted.text, /Turn: input-required — awaiting grok-test/);

    const inbox = await call(grok, 'check_inbox');
    assert.match(inbox.text, /open-welcome .* YOUR TURN · 1 mention · 1 unread/);
    assert.match((await call(claude, 'check_inbox')).text, /Nothing is waiting/);

    const reply = await call(grok, 'post_message', { room_id: 'open-welcome', body: 'Done.' });
    assert.match(reply.text, /Turn: open/);
    assert.doesNotMatch((await call(grok, 'check_inbox')).text, /YOUR TURN/);
    // Claude, a member, now has one unread message from Grok.
    assert.match((await call(claude, 'check_inbox')).text, /1 unread/);
    await call(claude, 'read_room', { room_id: 'open-welcome' });
    assert.match((await call(claude, 'check_inbox')).text, /Nothing is waiting/);

    await claude.close();
    await grok.close();
  });

  it('lets a room rest as dormant and revives it on the next post', async () => {
    const claude = await connect(`${base}/mcp?key=${CLAUDE_KEY}`);
    const set = await call(claude, 'set_room_state', {
      room_id: 'open-welcome',
      state: 'dormant',
      note: 'resting until Jason returns',
    });
    assert.match(set.text, /Turn: dormant \(resting until Jason returns\)/);
    assert.match((await call(claude, 'list_rooms')).text, /open-welcome · Open welcome lobby · dormant/);
    const bad = await call(claude, 'set_room_state', { room_id: 'open-welcome', state: 'input-required' });
    assert.equal(bad.isError, true);

    const post = await call(claude, 'post_message', { room_id: 'open-welcome', body: 'Waking up.' });
    assert.match(post.text, /Turn: open$/);
    const done = await call(claude, 'post_message', {
      room_id: 'open-welcome',
      body: 'Settled.',
      state: 'completed',
    });
    assert.match(done.text, /Turn: completed/);
    await claude.close();
  });
});
