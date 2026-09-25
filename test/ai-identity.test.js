/**
 * AI stream identity at join: a present agent_id is never handed a credential.
 * Mirrors the Open room's RR2 contract (409 handle_taken, Bearer re-join is idempotent).
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aiStore = require('../src/aiStore');

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

beforeEach(() => aiStore.clearAll());

async function send(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const join = (room, agentId, token) => send('POST', `/api/ai/rooms/${room}/join`, { party: 'ai', agent_id: agentId }, token);

const TAKEN = (id) => ({
  error: {
    code: 'handle_taken',
    message: `${id} is already present in this room. Re-join with its Bearer credential, or join after it leaves.`,
  },
});

describe('AI join: present agent_id', () => {
  it('repeat join without a Bearer → 409 handle_taken, exact body, no credential', async () => {
    const first = await join('ai-welcome', 'victim');
    assert.equal(first.status, 200);
    assert.ok(first.data.credential);

    const again = await join('ai-welcome', 'victim');
    assert.equal(again.status, 409);
    assert.deepEqual(again.data, TAKEN('victim'));
    assert.ok(!JSON.stringify(again.data).includes(first.data.credential));
  });

  it('repeat join with its own Bearer → 200, same membership, same credential, nothing minted', async () => {
    const first = await join('ai-welcome', 'victim');
    const hashesBefore = aiStore.getRoom('ai-welcome').roster.get('victim').credential_hashes.slice();
    const credsBefore = aiStore._credentials.size;

    const again = await join('ai-welcome', 'victim', first.data.credential);
    assert.equal(again.status, 200);
    assert.equal(again.data.credential, first.data.credential);
    assert.equal(again.data.room_id, 'ai-welcome');
    assert.equal(again.data.stream, 'ai');
    assert.equal(again.data.participants, 'A:A');
    assert.deepEqual(again.data.roster, first.data.roster);
    assert.deepEqual(aiStore.getRoom('ai-welcome').roster.get('victim').credential_hashes, hashesBefore);
    assert.equal(aiStore._credentials.size, credsBefore);

    // Idempotent: a third time behaves the same.
    const third = await join('ai-welcome', 'victim', first.data.credential);
    assert.equal(third.status, 200);
    assert.equal(third.data.credential, first.data.credential);
  });

  it('wrong Bearer → 409 handle_taken (forged, another agent’s, same id in another room)', async () => {
    const victim = await join('ai-welcome', 'victim');
    const other = await join('ai-welcome', 'other-bot');
    const reg = await send('POST', '/api/ai/rooms', { party: 'ai', agent_id: 'victim' });
    assert.equal(reg.status, 201);

    for (const token of ['forged', 'a'.repeat(48), other.data.credential, reg.data.credential]) {
      const res = await join('ai-welcome', 'victim', token);
      assert.equal(res.status, 409, token);
      assert.deepEqual(res.data, TAKEN('victim'));
    }
    // Nor does the victim's lobby Bearer re-join the victim's other room.
    const cross = await join(reg.data.room_id, 'victim', victim.data.credential);
    assert.equal(cross.status, 409);
    assert.equal(cross.data.error.code, 'handle_taken');
  });

  it('a stolen token is impossible: nothing is issued, so the attacker cannot post as the victim', async () => {
    const victim = await join('ai-welcome', 'victim');
    const attack = await join('ai-welcome', 'victim');
    assert.equal(attack.status, 409);
    assert.equal(attack.data.credential, undefined);

    const noToken = await send('POST', '/api/ai/rooms/ai-welcome/post', { body: 'I am victim' });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.data.error.code, 'invalid_credential');
    const forged = await send('POST', '/api/ai/rooms/ai-welcome/post', { body: 'I am victim' }, 'forged');
    assert.equal(forged.status, 401);

    // The victim's own token is untouched and still works.
    const post = await send('POST', '/api/ai/rooms/ai-welcome/post', { body: 'still me' }, victim.data.credential);
    assert.equal(post.status, 201);
    const list = await send('GET', '/api/ai/rooms/ai-welcome/messages', undefined, victim.data.credential);
    assert.deepEqual(list.data.messages.map((m) => [m.author, m.body]), [['victim', 'still me']]);
  });

  it('after leave the id is free: a fresh join gets a new credential; the old one is revoked', async () => {
    const first = await join('ai-welcome', 'victim');
    const leave = await send('POST', '/api/ai/rooms/ai-welcome/leave', undefined, first.data.credential);
    assert.equal(leave.status, 200);

    const fresh = await join('ai-welcome', 'victim');
    assert.equal(fresh.status, 200);
    assert.ok(fresh.data.credential);
    assert.notEqual(fresh.data.credential, first.data.credential);
    const old = await send('POST', '/api/ai/rooms/ai-welcome/post', { body: 'x' }, first.data.credential);
    assert.equal(old.status, 401);
    assert.equal(old.data.error.code, 'invalid_credential');
    // The old token does not re-join the new holder either.
    assert.equal((await join('ai-welcome', 'victim', first.data.credential)).status, 409);
  });

  it('absent id joins as before (a stray Bearer is ignored); register is unchanged', async () => {
    const res = await join('ai-welcome', 'newcomer', 'whatever');
    assert.equal(res.status, 200);
    assert.ok(res.data.credential);
    assert.notEqual(res.data.credential, 'whatever');
    const reg = await send('POST', '/api/ai/rooms', { party: 'ai', agent_id: 'newcomer' });
    assert.equal(reg.status, 201);
    assert.ok(reg.data.credential);
  });

  it('refusals keep their order: room_not_found, then not_ai / invalid_request / invalid_agent before handle_taken', async () => {
    await join('ai-welcome', 'victim');
    const human = await send('POST', '/api/ai/rooms/ai-welcome/join', { party: 'human', agent_id: 'victim' });
    assert.equal(human.status, 403);
    assert.equal(human.data.error.code, 'not_ai');
    const robot = await send('POST', '/api/ai/rooms/ai-welcome/join', { party: 'robot', agent_id: 'victim' });
    assert.equal(robot.data.error.code, 'not_ai');
    const noParty = await send('POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'victim' });
    assert.equal(noParty.status, 400);
    assert.equal(noParty.data.error.code, 'invalid_request');
    const bad = await send('POST', '/api/ai/rooms/ai-welcome/join', { party: 'ai', agent_id: 'bad id!' });
    assert.equal(bad.data.error.code, 'invalid_agent');
    const missing = await join('nope', 'victim');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error.code, 'room_not_found');
  });

  it('a full room still refuses newcomers with room_full; a present agent re-joins with its Bearer', async () => {
    const reg = await send('POST', '/api/ai/rooms', { party: 'ai', agent_id: 'a1' });
    const roomId = reg.data.room_id;
    for (let i = 2; i <= 16; i++) assert.equal((await join(roomId, `a${i}`)).status, 200);
    const full = await join(roomId, 'a17');
    assert.equal(full.status, 403);
    assert.equal(full.data.error.code, 'room_full');
    assert.equal((await join(roomId, 'a1')).status, 409);
    assert.equal((await join(roomId, 'a1', reg.data.credential)).status, 200);
  });
});

describe('AI join: store level', () => {
  let dir;
  afterEach(() => {
    aiStore.detach();
    aiStore.clearAll();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('a refused join writes nothing; a Bearer re-join after restart matches by hash and mints nothing', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyceum-ai-identity-'));
    const file = path.join(dir, 'ai-store.json');
    aiStore.attach(file, { log: { error() {}, log() {} } });
    const { credential } = aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'victim');
    const before = fs.readFileSync(file, 'utf8');

    assert.throws(() => aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'victim'), (e) => e.code === 'handle_taken');
    assert.equal(fs.readFileSync(file, 'utf8'), before);

    // "Restart": plaintext is gone from memory, only the hash is on disk.
    aiStore.attach(file, { log: { error() {}, log() {} } });
    assert.throws(() => aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'victim'), (e) => e.code === 'handle_taken');
    const again = aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'victim', { credential });
    assert.equal(again.credential, credential);
    assert.equal(again.created, false);
    assert.equal(aiStore.getRoom('ai-welcome').roster.get('victim').credential_hashes.length, 1);
  });

  it('a present entry with no live credential (partial legacy import) is re-claimable like an absent id', () => {
    const room = aiStore.getRoom('ai-welcome');
    room.roster.set('ghost', { agent_id: 'ghost', joined_at: new Date().toISOString(), credential_hashes: [] });
    const res = aiStore.joinAgent(room, 'ghost');
    assert.ok(res.credential);
    assert.deepEqual(aiStore.resolveCredential(res.credential), { room_id: 'ai-welcome', agent_id: 'ghost' });
    assert.throws(() => aiStore.joinAgent(room, 'ghost'), (e) => e.code === 'handle_taken');
  });
});
