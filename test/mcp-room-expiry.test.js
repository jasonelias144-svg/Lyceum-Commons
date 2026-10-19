/**
 * Rooms made by MCP create_room empty and are deleted once the creator's seat times out
 * (MCP has no leave tool), including leftovers restored from snapshots made before
 * room.mcp_creator existed. Other rooms keep "expiry never deletes a room".
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const openStore = require('../src/openStore');
const persist = require('../src/persist');
const rateLimit = require('../src/rateLimit');

const KEY = 'claude-test-key-0123456789abcdef';
const TTL = openStore.DEFAULT_PRESENCE_TTL_MS;
let server;
let base;
let t;

before(async () => {
  process.env.LYCEUM_MCP_KEYS = `claude-test=${KEY}`;
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
  openStore._setClock();
  rateLimit._reset();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  t = 5_000_000_000_000;
  openStore._setClock(() => t);
  openStore.clearAll();
  rateLimit._reset();
});

async function createViaMcp(args) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?key=${KEY}`)));
  const r = await client.callTool({ name: 'create_room', arguments: args });
  await client.close();
  const m = r.content[0].text.match(/\[(orm_[^\]]+)\]/);
  return m[1];
}

describe('MCP-made room expiry', () => {
  it('marks the creator and deletes the room once its seat times out', async () => {
    const id = await createViaMcp({ title: 'qc', opening: 'hello' });
    const room = openStore._openRooms.get(id);
    assert.equal(room.mcp_creator, 'claude-test');
    t += TTL - 1000;
    assert.ok(openStore.getRoom(id), 'still there inside the TTL');
    t += 2000;
    assert.equal(openStore.getRoom(id), null);
    assert.equal(openStore._openRooms.has(id), false);
  });

  it('keeps the room when someone else is a member', async () => {
    const id = await createViaMcp({ title: 'shared' });
    openStore.joinAi(openStore.getRoom(id), 'other-bot');
    t += TTL + 1000;
    const room = openStore.getRoom(id);
    assert.ok(room, 'other member keeps it');
    assert.equal(room.members['ai:claude-test'], undefined);
    assert.equal(room.members['ai:other-bot'], true);
  });

  it('leaves non-MCP rooms alone (timed-out AI stays a member)', () => {
    const room = openStore.createRoom({ title: 'api' });
    openStore.joinAi(room, 'solo');
    openStore.addMessage(room, { author: 'solo', party: 'ai', body: 'hi' });
    t += TTL + 1000;
    const again = openStore.getRoom(room.id);
    assert.ok(again);
    assert.equal(again.members['ai:solo'], true);
  });

  it('API rooms store mcp_creator null, kept distinct from missing across restore', () => {
    const room = openStore.createRoom({ title: 'qc-live-h33-9' });
    assert.equal(room.mcp_creator, null);
    const snap = JSON.parse(JSON.stringify(persist.serialize()));
    openStore.clearAll();
    persist.restore(snap);
    const back = openStore._openRooms.get(room.id);
    assert.ok('mcp_creator' in back);
    assert.equal(back.mcp_creator, null);
  });

  it('an API room with one lone AI survives two restarts plus TTLs', () => {
    const room = openStore.createRoom({ title: 'qc-live-h33-4' }); // even with a matching title
    openStore.joinAi(room, 'solo');
    openStore.addMessage(room, { author: 'solo', party: 'ai', body: 'hi' });
    for (let i = 0; i < 2; i++) {
      const snap = JSON.parse(JSON.stringify(persist.serialize()));
      openStore.clearAll();
      persist.restore(snap);
      t += TTL + 1000;
      assert.ok(openStore.getRoom(room.id), `kept after restart ${i + 1}`);
    }
    assert.equal(openStore._openRooms.get(room.id).members['ai:solo'], true);
  });

  function legacySnapshot(titles) {
    const ids = titles.map((title) => {
      const room = openStore.createRoom({ title });
      openStore.joinAi(room, 'claude-test');
      openStore.addMessage(room, { author: 'claude-test', party: 'ai', body: 'x' });
      delete room.mcp_creator; // as saved before mcp_creator existed
      return room.id;
    });
    const snap = JSON.parse(JSON.stringify(persist.serialize()));
    delete snap.migrations; // snapshot from before the migration flag
    return { ids, snap };
  }

  it('one-time migration clears a matching qc-live-h33 room, keeps a non-matching lone-AI room', () => {
    const { ids: [qc, other], snap } = legacySnapshot(['qc-live-h33-1', 'my agent room']);
    t += 3 * 24 * 60 * 60 * 1000;
    openStore.clearAll();
    persist.restore(snap);
    assert.equal(openStore._openRooms.get(qc).mcp_creator, 'claude-test');
    assert.equal('mcp_creator' in openStore._openRooms.get(other), false);
    assert.ok(openStore.getRoom(qc), 'restored seat gets one fresh TTL from boot');
    t += TTL + 1000;
    assert.equal(openStore.getRoom(qc), null);
    assert.ok(openStore.getRoom(other), 'non-matching lone-AI room kept');
    assert.equal(persist.serialize().migrations.mcpLegacyAdopt, true);
  });

  it('the migration does not re-run once the snapshot flag is set', () => {
    const { ids: [qc], snap } = legacySnapshot(['qc-live-h33-2']);
    snap.migrations = { mcpLegacyAdopt: true };
    openStore.clearAll();
    persist.restore(snap);
    assert.equal('mcp_creator' in openStore._openRooms.get(qc), false);
    t += TTL + 1000;
    assert.ok(openStore.getRoom(qc), 'not adopted, so kept');
  });

  it('deletes a migrated room whose creator seat had already timed out', () => {
    const { ids: [qc], snap } = legacySnapshot(['qc-live-h33-7']);
    const saved = snap.open.rooms.find((r) => r.id === qc);
    saved.roster = [];
    openStore.clearAll();
    persist.restore(snap);
    assert.equal(openStore.getRoom(qc), null);
  });
});
