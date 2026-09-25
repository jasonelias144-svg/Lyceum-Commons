/**
 * Snapshot persistence — runs the real server as a child process with a data
 * directory, writes through every layer, stops it with SIGTERM (as Railway does on
 * redeploy), starts it again and checks that everything came back.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyceum-persist-'));

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(port, env = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), ...env },
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
  child.kill();
  throw new Error(`server did not start:\n${log}`);
}

function stop(child) {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
}

async function send(base, method, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe('snapshot persistence', () => {
  it('survives a SIGTERM restart across human, ai, open and guest book', async () => {
    const port = await freePort();
    const env = { LYCEUM_DATA_DIR: dataDir, AI_STORE_PATH: '' };

    let s = await startServer(port, env);
    await send(s.base, 'POST', '/api/guestbook', { handle: 'jason', body: 'first signature' });
    await send(s.base, 'POST', '/api/human/rooms/welcome/join', { handle: 'jason', party: 'human' });
    await send(s.base, 'POST', '/api/human/rooms/welcome/post', { handle: 'jason', body: 'hello humans' });
    const ai = await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/join', { agent_id: 'bot', party: 'ai' });
    const aiCred = ai.data.credential;
    await send(s.base, 'POST', '/api/ai/rooms/ai-welcome/post', { body: 'hello machines' }, {
      Authorization: `Bearer ${aiCred}`,
    });
    const room = await send(s.base, 'POST', '/api/open/rooms', {});
    const roomId = room.data.room_id;
    await send(s.base, 'POST', `/api/open/rooms/${roomId}/join`, { handle: 'jason', party: 'human' });
    await send(s.base, 'POST', `/api/open/rooms/${roomId}/post`, { handle: 'jason', body: 'open question' });
    const exitCode = await stop(s.child);
    assert.equal(exitCode, 0);
    assert.ok(fs.existsSync(path.join(dataDir, 'lyceum-snapshot.json')));
    // AI data lives in its own file, never in the shared snapshot.
    assert.ok(fs.existsSync(path.join(dataDir, 'ai', 'ai-store.json')));
    const shared = JSON.parse(fs.readFileSync(path.join(dataDir, 'lyceum-snapshot.json'), 'utf8'));
    assert.equal(shared.ai, undefined);

    s = await startServer(port, env);
    try {
      assert.match(s.log(), /Restored state/);
      const gb = await send(s.base, 'GET', '/api/guestbook');
      assert.equal(gb.data.signatures[0].body, 'first signature');

      const hm = await send(s.base, 'GET', '/api/human/rooms/welcome/messages?handle=jason');
      assert.ok(hm.data.messages.some((m) => m.body === 'hello humans'));

      // The AI credential minted before the restart still works.
      const am = await send(s.base, 'GET', '/api/ai/rooms/ai-welcome/messages', undefined, {
        Authorization: `Bearer ${aiCred}`,
      });
      assert.equal(am.status, 200);
      assert.ok(am.data.messages.some((m) => m.body === 'hello machines'));

      const om = await send(s.base, 'GET', `/api/open/rooms/${roomId}/messages?handle=jason`);
      assert.equal(om.data.messages[0].body, 'open question');

      // Seeded topics are not duplicated by restoring on top of them.
      const topics = await send(s.base, 'GET', '/api/human/topics');
      assert.equal(topics.data.topics.length, 12);
      assert.ok(topics.data.topics.every((t) => t.message_count === 1));
    } finally {
      await stop(s.child);
    }
  });

  it('stays in memory only when no data directory is configured', async () => {
    const port = await freePort();
    const env = { LYCEUM_DATA_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: '', AI_STORE_PATH: ':memory:' };
    const s = await startServer(port, env);
    try {
      assert.match(s.log(), /in memory only/);
    } finally {
      await stop(s.child);
    }
  });
});
