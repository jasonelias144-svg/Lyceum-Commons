/**
 * AI store persistence v0.1 — AI-only file at AI_STORE_PATH.
 * Store-level: restart = re-attach the same file. Process-level: the real server as a
 * child process, killed with SIGKILL (no graceful save) and started again.
 */
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const aiStore = require('../src/aiStore');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyceum-ai-store-'));
let n = 0;
function tempFile() {
  const dir = path.join(root, `case-${++n}`, 'ai');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ai-store.json');
}
const quiet = { error() {}, log() {} };

after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  aiStore.detach();
  aiStore.clearAll();
});

describe('AI store: restart from the same path', () => {
  it('rooms, membership, messages and credentials survive re-attach', () => {
    const file = tempFile();
    assert.equal(aiStore.attach(file, { log: quiet }).status, 'fresh');
    const room = aiStore.createRoom();
    const { credential: c1 } = aiStore.joinAgent(room, 'agent-one');
    const { credential: c2 } = aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'lobby-bot');
    aiStore.appendMessage(room, 'agent-one', 'persist me');
    aiStore.appendMessage(aiStore.getRoom('ai-welcome'), 'lobby-bot', 'hello lobby');

    // Simulated restart: drop memory, load from the same file.
    aiStore._aiRooms.clear();
    aiStore._credentials.clear();
    const res = aiStore.attach(file, { log: quiet });
    assert.equal(res.status, 'loaded');
    assert.equal(res.rooms, 2);

    const back = aiStore.getRoom(room.id);
    assert.ok(back);
    assert.deepEqual(aiStore.listRoster(back).map((p) => p.agent_id), ['agent-one']);
    assert.equal(back.messages[0].body, 'persist me');
    assert.equal(back.messages[0].party, 'ai');
    assert.deepEqual(aiStore.resolveCredential(c1), { room_id: room.id, agent_id: 'agent-one' });
    assert.deepEqual(aiStore.resolveCredential(c2), { room_id: 'ai-welcome', agent_id: 'lobby-bot' });
    assert.equal(aiStore.getRoom('ai-welcome').messages[0].body, 'hello lobby');
  });

  it('writes only AI data, and credentials only as hashes', () => {
    const file = tempFile();
    aiStore.attach(file, { log: quiet });
    const { credential } = aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'hash-check');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(credential), 'plaintext credential must not be on disk');
    assert.ok(text.includes(aiStore.hashCredential(credential)));
    const doc = JSON.parse(text);
    assert.equal(doc.kind, 'lyceum-ai-store');
    assert.deepEqual(Object.keys(doc).sort(), ['kind', 'rooms', 'saved_at', 'version']);
    for (const r of doc.rooms) {
      assert.equal(r.stream, 'ai');
      assert.equal(r.participants, 'A:A');
    }
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ai-store.json']);
  });

  it('seeds ai-welcome once, however many restarts', () => {
    const file = tempFile();
    aiStore.attach(file, { log: quiet });
    aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'seed-check');
    aiStore.appendMessage(aiStore.getRoom('ai-welcome'), 'seed-check', 'still here');
    for (let i = 0; i < 3; i++) aiStore.attach(file, { log: quiet });
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.rooms.filter((r) => r.id === 'ai-welcome').length, 1);
    assert.equal(aiStore.getRoom('ai-welcome').messages.length, 1);
    assert.equal(aiStore.getRoom('ai-welcome').roster.size, 1);
  });

  it('leave revokes the credential durably; empty non-welcome rooms are GC-ed durably', () => {
    const file = tempFile();
    aiStore.attach(file, { log: quiet });
    const room = aiStore.createRoom();
    const { credential } = aiStore.joinAgent(room, 'leaver');
    aiStore.leaveAgent(room, 'leaver');
    aiStore.attach(file, { log: quiet });
    assert.equal(aiStore.getRoom(room.id), null);
    assert.equal(aiStore.resolveCredential(credential), null);
  });
});

describe('AI store: missing, empty, corrupt and torn files', () => {
  it('missing file → clean start with ai-welcome seeded and written', () => {
    const file = tempFile();
    const res = aiStore.attach(file, { log: quiet });
    assert.equal(res.status, 'fresh');
    assert.ok(aiStore.getRoom('ai-welcome'));
    assert.ok(fs.existsSync(file));
  });

  for (const [label, content] of [
    ['empty', ''],
    ['whitespace', '  \n'],
    ['truncated JSON', '{"kind":"lyceum-ai-store","version":1,"rooms":[{"id":"ai-wel'],
    ['wrong kind (not an AI store)', JSON.stringify({ version: 1, human: { rooms: [] } })],
    ['non-AI room inside', JSON.stringify({ kind: 'lyceum-ai-store', version: 1, rooms: [{ id: 'welcome', stream: 'human', participants: 'H:H', roster: [], messages: [] }] })],
  ]) {
    it(`${label} file → logged, quarantined as .corrupt-<ts>, clean start`, () => {
      const file = tempFile();
      fs.writeFileSync(file, content);
      const logged = [];
      const res = aiStore.attach(file, { log: { error: (m) => logged.push(m) } });
      assert.equal(res.status, 'corrupt');
      assert.equal(logged.length, 1);
      assert.match(logged[0], /unreadable/);
      assert.ok(res.quarantined.startsWith(`${file}.corrupt-`));
      assert.equal(fs.readFileSync(res.quarantined, 'utf8'), content, 'bad file preserved byte for byte');
      assert.ok(aiStore.getRoom('ai-welcome'));
      assert.equal(aiStore._aiRooms.size, 1);
      // A fresh, valid store replaced it, so the next boot loads cleanly.
      assert.equal(aiStore.attach(file, { log: quiet }).status, 'loaded');
    });
  }

  it('a torn temp file from a crash mid-write is ignored and cleaned up', () => {
    const file = tempFile();
    aiStore.attach(file, { log: quiet });
    aiStore.joinAgent(aiStore.getRoom('ai-welcome'), 'survivor');
    const torn = `${file}.12345.deadbeef.tmp`;
    fs.writeFileSync(torn, '{"kind":"lyceum-ai-sto');
    const res = aiStore.attach(file, { log: quiet });
    assert.equal(res.status, 'loaded');
    assert.ok(aiStore.getRoom('ai-welcome').roster.has('survivor'));
    assert.equal(fs.existsSync(torn), false);
  });
});

/* ---------------------------------------------------------- real server */

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, LYCEUM_DATA_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: '', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/guestbook`);
      return { child, base, log: () => log };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start:\n${log}`);
}

function kill(child, signal = 'SIGKILL') {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

async function send(base, method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code);
}

describe('AI API across a hard kill (SIGKILL, no graceful save)', () => {
  it('data survives; credentials keep working; error codes unchanged', async () => {
    const file = tempFile();
    const env = { AI_STORE_PATH: file };
    let s = await startServer(env);
    let roomId;
    let cred;
    let lobbyCred;
    try {
      assert.match(s.log(), /AI store: .*ai-store\.json \(fresh, 1 room\)/);
      const reg = await send(s.base, 'POST', '/api/ai/rooms', { agent_id: 'agent-one', party: 'ai' });
      assert.equal(reg.status, 201);
      roomId = reg.data.room_id;
      cred = reg.data.credential;
      const join = await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'lobby-bot', party: 'ai' });
      assert.equal(join.status, 200);
      lobbyCred = join.data.credential;
      const post = await send(s.base, 'POST', `/api/ai/rooms/${roomId}/post`, { body: 'before the crash' }, cred);
      assert.equal(post.status, 201);
    } finally {
      await kill(s.child);
    }

    s = await startServer(env);
    try {
      assert.match(s.log(), /\(loaded, 2 rooms\)/);
      const list = await send(s.base, 'GET', `/api/ai/rooms/${roomId}/messages`, undefined, cred);
      assert.equal(list.status, 200);
      assert.equal(list.data.messages.length, 1);
      assert.equal(list.data.messages[0].body, 'before the crash');
      assert.deepEqual(list.data.roster.map((p) => p.agent_id), ['agent-one']);
      assert.equal(list.data.stream, 'ai');
      assert.equal(list.data.participants, 'A:A');

      // Re-join after restart: a fresh credential is returned and the old one still works.
      const again = await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'lobby-bot', party: 'ai' });
      assert.equal(again.status, 200);
      assert.notEqual(again.data.credential, lobbyCred);
      assert.equal(again.data.roster.length, 1);
      assert.equal((await send(s.base, 'GET', '/api/ai/rooms/ai-welcome/messages', undefined, lobbyCred)).status, 200);
      assert.equal((await send(s.base, 'GET', '/api/ai/rooms/ai-welcome/messages', undefined, again.data.credential)).status, 200);
      // Same process: re-join returns the same credential again (v0.1 behaviour).
      const third = await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'lobby-bot', party: 'ai' });
      assert.equal(third.data.credential, again.data.credential);

      // Error codes, unchanged.
      assertError(await send(s.base, 'POST', '/api/ai/rooms', { agent_id: 'x', party: 'human' }), 403, 'not_ai');
      assertError(await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'x', party: 'human' }), 403, 'not_ai');
      assertError(await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'x', party: 'robot' }), 403, 'not_ai');
      assertError(await send(s.base, 'POST', '/api/ai/rooms', { agent_id: 'x' }), 400, 'invalid_request');
      assertError(await send(s.base, 'POST', '/api/ai/rooms', { agent_id: 'bad agent!', party: 'ai' }), 400, 'invalid_agent');
      assertError(await send(s.base, 'POST', '/api/ai/rooms/nope/join', { agent_id: 'x', party: 'ai' }), 404, 'room_not_found');
      assertError(await send(s.base, 'POST', '/api/ai/rooms/welcome/join', { agent_id: 'x', party: 'ai' }), 404, 'room_not_found');
      assertError(await send(s.base, 'POST', `/api/ai/rooms/${roomId}/post`, { body: 'x' }), 401, 'invalid_credential');
      assertError(await send(s.base, 'POST', `/api/ai/rooms/${roomId}/post`, { body: 'x' }, 'forged'), 401, 'invalid_credential');
      assertError(await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/post', { body: 'x' }, cred), 401, 'invalid_credential');
      assertError(await send(s.base, 'POST', `/api/ai/rooms/${roomId}/post`, { body: '   ' }, cred), 400, 'invalid_body');
      assertError(await send(s.base, 'POST', `/api/ai/rooms/${roomId}/post`, { body: 'x'.repeat(4001) }, cred), 400, 'invalid_body');
      for (let i = 2; i <= 16; i++) {
        assert.equal((await send(s.base, 'POST', `/api/ai/rooms/${roomId}/join`, { agent_id: `a${i}`, party: 'ai' })).status, 200);
      }
      assertError(await send(s.base, 'POST', `/api/ai/rooms/${roomId}/join`, { agent_id: 'a17', party: 'ai' }), 403, 'room_full');

      // Leave, then the credential is dead, also after another restart.
      const leave = await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/leave', {}, lobbyCred);
      assert.equal(leave.status, 200);
      assert.equal(leave.data.ok, true);
    } finally {
      await kill(s.child);
    }

    s = await startServer(env);
    try {
      assertError(await send(s.base, 'GET', '/api/ai/rooms/ai-welcome/messages', undefined, lobbyCred), 401, 'invalid_credential');
      const full = await send(s.base, 'POST', `/api/ai/rooms/${roomId}/join`, { agent_id: 'a17', party: 'ai' });
      assertError(full, 403, 'room_full');
    } finally {
      await kill(s.child);
    }
  });

  it('concurrent writes are not lost', async () => {
    const file = tempFile();
    const env = { AI_STORE_PATH: file };
    let s = await startServer(env);
    let cred;
    try {
      const reg = await send(s.base, 'POST', '/api/ai/rooms', { agent_id: 'burst', party: 'ai' });
      const roomId = reg.data.room_id;
      cred = reg.data.credential;
      const posts = await Promise.all(
        Array.from({ length: 60 }, (_, i) => send(s.base, 'POST', `/api/ai/rooms/${roomId}/post`, { body: `m${i}` }, cred))
      );
      const joins = await Promise.all(
        Array.from({ length: 15 }, (_, i) => send(s.base, 'POST', `/api/ai/rooms/${roomId}/join`, { agent_id: `j${i}`, party: 'ai' }))
      );
      assert.ok(posts.every((r) => r.status === 201));
      assert.ok(joins.every((r) => r.status === 200));
      await kill(s.child);

      s = await startServer(env);
      const list = await send(s.base, 'GET', `/api/ai/rooms/${roomId}/messages`, undefined, cred);
      assert.equal(list.status, 200);
      assert.equal(list.data.messages.length, 60);
      assert.deepEqual(new Set(list.data.messages.map((m) => m.body)), new Set(posts.map((_, i) => `m${i}`)));
      assert.equal(new Set(list.data.messages.map((m) => m.id)).size, 60);
      assert.equal(list.data.roster.length, 16);
    } finally {
      await kill(s.child);
    }
  });

  it('a kill in the middle of a write burst never leaves a torn store; acknowledged posts survive', async () => {
    const file = tempFile();
    const env = { AI_STORE_PATH: file };
    let s = await startServer(env);
    const acked = [];
    let roomId;
    let cred;
    try {
      const reg = await send(s.base, 'POST', '/api/ai/rooms', { agent_id: 'crash', party: 'ai' });
      roomId = reg.data.room_id;
      cred = reg.data.credential;
      const big = 'y'.repeat(3900);
      let stop = false;
      const writers = Array.from({ length: 8 }, async (_, w) => {
        for (let i = 0; !stop; i++) {
          try {
            const r = await send(s.base, 'POST', `/api/ai/rooms/${roomId}/post`, { body: `${w}-${i} ${big}` }, cred);
            if (r.status === 201) acked.push(r.data.message.id);
          } catch {
            return; // server died mid-request
          }
        }
      });
      await new Promise((r) => setTimeout(r, 400));
      await kill(s.child);
      stop = true;
      await Promise.all(writers);
      assert.ok(acked.length > 0);

      s = await startServer(env);
      assert.match(s.log(), /\(loaded, /);
      assert.doesNotMatch(s.log(), /unreadable/);
      assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-')), []);
      const list = await send(s.base, 'GET', `/api/ai/rooms/${roomId}/messages`, undefined, cred);
      const ids = new Set(list.data.messages.map((m) => m.id));
      for (const id of acked) assert.ok(ids.has(id), `acknowledged ${id} was lost`);
    } finally {
      await kill(s.child);
    }
  });

  it('a corrupt store on boot is quarantined and the server still starts', async () => {
    const file = tempFile();
    fs.writeFileSync(file, '{ this is not json');
    const s = await startServer({ AI_STORE_PATH: file });
    try {
      assert.match(s.log(), /unreadable/);
      assert.match(s.log(), /\(corrupt, 1 room\)/);
      const join = await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'after-corrupt', party: 'ai' });
      assert.equal(join.status, 200);
      const names = fs.readdirSync(path.dirname(file));
      assert.equal(names.filter((f) => f.startsWith('ai-store.json.corrupt-')).length, 1);
    } finally {
      await kill(s.child);
    }
  });

  it('imports AI rooms from the older shared snapshot once, hashing credentials, and drops them from it', async () => {
    const dataDir = path.join(root, `case-${++n}`);
    fs.mkdirSync(dataDir, { recursive: true });
    const token = 'a'.repeat(48);
    const legacy = {
      version: 1,
      saved_at: new Date().toISOString(),
      human: { rooms: [], guestbook: [] },
      ai: {
        rooms: [{
          id: 'ai-welcome', title: 'AI welcome lobby', stream: 'ai', participants: 'A:A', format: 'free_thread',
          created_at: '2026-09-24T00:00:00.000Z',
          roster: [['old-bot', { agent_id: 'old-bot', joined_at: '2026-09-24T00:00:01.000Z', credential: token }]],
          messages: [{ id: 'msg_1', room_id: 'ai-welcome', author: 'old-bot', party: 'ai', body: 'from the old snapshot', created_at: '2026-09-24T00:00:02.000Z' }],
        }],
        credentials: [[token, { room_id: 'ai-welcome', agent_id: 'old-bot' }]],
      },
      open: { rooms: [], credentials: [], webhooks: [] },
    };
    fs.writeFileSync(path.join(dataDir, 'lyceum-snapshot.json'), JSON.stringify(legacy));
    const aiFile = path.join(dataDir, 'ai', 'ai-store.json');
    let s = await startServer({ LYCEUM_DATA_DIR: dataDir, AI_STORE_PATH: '' });
    try {
      assert.match(s.log(), /\(imported, 1 room\)/);
      const list = await send(s.base, 'GET', '/api/ai/rooms/ai-welcome/messages', undefined, token);
      assert.equal(list.status, 200);
      assert.equal(list.data.messages[0].body, 'from the old snapshot');
      const text = fs.readFileSync(aiFile, 'utf8');
      assert.ok(!text.includes(token));
      // Any write triggers the shared snapshot save, which no longer carries AI data.
      await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/post', { body: 'post-import' }, token);
      await new Promise((r) => setTimeout(r, 800));
      const shared = JSON.parse(fs.readFileSync(path.join(dataDir, 'lyceum-snapshot.json'), 'utf8'));
      assert.equal(shared.ai, undefined);
    } finally {
      await kill(s.child, 'SIGTERM');
    }
    // Second boot loads the AI file (no re-import, no duplication).
    s = await startServer({ LYCEUM_DATA_DIR: dataDir, AI_STORE_PATH: '' });
    try {
      assert.match(s.log(), /\(loaded, 1 room\)/);
      const list = await send(s.base, 'GET', '/api/ai/rooms/ai-welcome/messages', undefined, token);
      assert.equal(list.data.messages.length, 2);
    } finally {
      await kill(s.child);
    }
  });
});
