/**
 * MCP create_room per-connector limit (MCP_CREATE_ROOM_RATE_PER_MIN, default 6, 0 = off).
 * Keyed by the agent label the MCP key resolves to, not by address; its refusal reads
 * "You're creating rooms quickly." while other MCP limits keep "You're posting quickly.".
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const openStore = require('../src/openStore');
const rateLimit = require('../src/rateLimit');

const CLAUDE_KEY = 'claude-test-key-0123456789abcdef';
const GROK_KEY = 'grok-test-key-0123456789abcdef00';

let server;
let base;
let now;

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
  delete process.env.MCP_CREATE_ROOM_RATE_PER_MIN;
  rateLimit._reset();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  openStore.clearAll();
  rateLimit._reset();
  delete process.env.MCP_CREATE_ROOM_RATE_PER_MIN;
  now = 1_000_000;
  rateLimit._setClock(() => now);
});

async function connect(key) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?key=${key}`)));
  return client;
}

async function create(client, args) {
  const r = await client.callTool({ name: 'create_room', arguments: args });
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
}

describe('MCP create_room limit', () => {
  it('refuses the 7th create for one agent with the create copy and a wait', async () => {
    const claude = await connect(CLAUDE_KEY);
    for (let i = 1; i <= 6; i++) {
      const r = await create(claude, { title: `Room ${i}` });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /^Created Room \d \[orm_[0-9a-f]+\]\.$/);
    }
    const before = openStore.listRooms().length;
    const r = await create(claude, { title: 'Room 7' });
    assert.equal(r.isError, true);
    assert.equal(r.text, "You're creating rooms quickly. (in about 10 seconds).");
    assert.doesNotMatch(r.text, /posting/);
    assert.equal(openStore.listRooms().length, before, 'a refused create makes no room');
    // One create comes back every 10 s.
    now += 10000;
    assert.equal((await create(claude, { title: 'Room 8' })).isError, false);
    assert.equal((await create(claude, { title: 'Room 9' })).isError, true);
    await claude.close();
  });

  it('a second agent is unaffected by the first agent hitting its limit', async () => {
    const claude = await connect(CLAUDE_KEY);
    const grok = await connect(GROK_KEY);
    for (let i = 0; i < 6; i++) await create(claude, { title: `C${i}` });
    assert.equal((await create(claude, { title: 'C7' })).isError, true);
    for (let i = 0; i < 6; i++) {
      const r = await create(grok, { title: `G${i}` });
      assert.equal(r.isError, false, r.text);
    }
    assert.equal((await create(grok, { title: 'G7' })).isError, true);
    await claude.close();
    await grok.close();
  });

  it('is keyed per agent, not per address: every create here comes from one address', async () => {
    // Both connectors above share 127.0.0.1; HTTP Open creates are off in npm test, and the
    // MCP bucket names carry only the agent label.
    const claude = await connect(CLAUDE_KEY);
    await create(claude, { title: 'one' });
    const keys = [...rateLimit._buckets.keys()].filter((k) => k.startsWith('mcp:create:'));
    assert.deepEqual(keys, ['mcp:create:claude-test']);
    await claude.close();
  });

  it('MCP_CREATE_ROOM_RATE_PER_MIN=0 turns the limit off', async () => {
    process.env.MCP_CREATE_ROOM_RATE_PER_MIN = '0';
    const claude = await connect(CLAUDE_KEY);
    for (let i = 0; i < 20; i++) {
      const r = await create(claude, { title: `Room ${i}` });
      assert.equal(r.isError, false, r.text);
    }
    await claude.close();
  });

  it('honours a configured value, and a bad value falls back to 6', async () => {
    process.env.MCP_CREATE_ROOM_RATE_PER_MIN = '2';
    const claude = await connect(CLAUDE_KEY);
    assert.equal((await create(claude, { title: 'a' })).isError, false);
    assert.equal((await create(claude, { title: 'b' })).isError, false);
    assert.equal((await create(claude, { title: 'c' })).text, "You're creating rooms quickly. (in about 30 seconds).");
    rateLimit._reset();
    rateLimit._setClock(() => now);
    process.env.MCP_CREATE_ROOM_RATE_PER_MIN = 'six';
    const warn = console.warn;
    const warnings = [];
    console.warn = (m) => warnings.push(String(m));
    try {
      for (let i = 0; i < 6; i++) assert.equal((await create(claude, { title: `x${i}` })).isError, false);
      assert.equal((await create(claude, { title: 'x7' })).isError, true);
    } finally {
      console.warn = warn;
    }
    assert.ok(warnings.some((w) => w.includes('MCP_CREATE_ROOM_RATE_PER_MIN') && w.includes('default 6')));
    await claude.close();
  });

  it('checkKnobs warns about a bad value at boot', () => {
    process.env.MCP_CREATE_ROOM_RATE_PER_MIN = '-1';
    const warn = console.warn;
    const warnings = [];
    console.warn = (m) => warnings.push(String(m));
    try {
      rateLimit.checkKnobs();
    } finally {
      console.warn = warn;
    }
    assert.ok(warnings.some((w) => w.includes('MCP_CREATE_ROOM_RATE_PER_MIN')));
  });

  it('an opening over the post limit keeps "posting" copy and burns no create', async () => {
    const claude = await connect(CLAUDE_KEY);
    for (let i = 0; i < rateLimit.DEFAULT_PER_MIN; i++) assert.equal(rateLimit.takePost('mcp:claude-test'), 0);
    const r = await create(claude, { title: 'With opening', opening: 'Question?' });
    assert.equal(r.isError, true);
    assert.match(r.text, /^You're posting quickly\. \(in about \d+ seconds?\)\.$/);
    // The refused create cost nothing: all six creates (without openings) still go through.
    for (let i = 0; i < 6; i++) assert.equal((await create(claude, { title: `n${i}` })).isError, false);
    assert.equal((await create(claude, { title: 'n7' })).isError, true);
    await claude.close();
  });

  it('other MCP limits keep their copy', async () => {
    const claude = await connect(CLAUDE_KEY);
    const made = await create(claude, { title: 'Talk' });
    const id = made.text.match(/\[(orm_[0-9a-f]+)\]/)[1];
    for (let i = 0; i < rateLimit.DEFAULT_PER_MIN; i++) rateLimit.takePost('mcp:claude-test');
    const r = await claude.callTool({ name: 'post_message', arguments: { room_id: id, body: 'hi' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^You're posting quickly\./);
    await claude.close();
  });
});
