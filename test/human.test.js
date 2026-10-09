/**
 * Human API tests — welcome lobby, verbs, refuse AI parties on Human stream.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { guestHeaders, remember } = require('./guest-jar');
const store = require('../src/store');

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
});

/** One browser per handle: the guest key a join returns is sent on later calls as that handle. */
async function json(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...guestHeaders(path, body) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  remember(path, body, data);
  return { status: res.status, data };
}

describe('pages', () => {
  it('serves / /human /ai /open', async () => {
    for (const p of ['/', '/human', '/ai', '/open', '/docs/protocol']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /Lyceum Commons/);
    }
  });

  it('home has three peer doors, locked welcome line, not a chat-with-AI CTA', async () => {
    const text = await (await fetch(`${base}/`)).text();
    assert.match(text, />Human</);
    assert.match(text, />AI</);
    assert.match(text, />Open</);
    assert.match(
      text,
      /Welcome to Lyceum Commons\. Human, AI, and Open are peer doors — choose one when you.re ready\./
    );
    assert.match(text, /class="face"/);
    assert.match(text, /class="atrium"/);
    // Human door arrives at welcome lobby; AI/Open stay stubs
    assert.match(text, /href=["']\/human\?room=welcome["']/);
    assert.match(text, /href=["']\/ai["']/);
    assert.match(text, /href=["']\/open["']/);
    assert.match(text, /guest book/i);
    assert.match(text, /Sign the guest book/);
    assert.match(text, /Be the first to sign/);
    assert.doesNotMatch(text, /topic shelf/i);
    assert.doesNotMatch(text, /href=["'][^"']*["'][^>]*>\s*chat with AI/i);
    assert.doesNotMatch(text, /Start chatting/i);
    assert.doesNotMatch(text, /enter with an AI/i);
  });

  it('home Human door is welcome path; no under-grid CTA; /human keeps lobby CTA', async () => {
    const home = await (await fetch(`${base}/`)).text();
    // Human door alone is the welcome path — no solid under-grid primacy CTA
    assert.match(home, /href=["']\/human\?room=welcome["']/);
    assert.match(home, /data-room=["']human["']/);
    assert.match(home, /Enter welcome lobby/);
    assert.doesNotMatch(home, /class=["'][^"']*btn-cta/);
    assert.doesNotMatch(home, /class=["'][^"']*face-arrive/);
    // peers stay equal — AI/Open present; guest book is quiet companion, not a door
    assert.match(home, /data-room=["']ai["']/);
    assert.match(home, /data-room=["']open["']/);
    assert.match(home, /class=["'][^"']*guestbook/);
    assert.match(home, /Sign the guest book/);
    assert.doesNotMatch(home, /topic shelf/i);

    const human = await (await fetch(`${base}/human`)).text();
    assert.match(human, /Enter welcome lobby/);
    assert.match(human, /id="btn-welcome"/);
    assert.match(human, /Welcome lobby/);
    assert.match(human, /hotel or conference-center lobby/);
    assert.match(human, /guest book/i);
    assert.match(human, /Sign the guest book/);
    assert.match(human, /Be the first to sign/);
    assert.match(human, /Topic rooms/);
    assert.match(human, /id="topic-shelf"/);
    assert.match(human, /Field of Dreams/);
    // create is secondary
    assert.match(human, /id="btn-create"[^>]*class="secondary"|class="secondary"[^>]*id="btn-create"/);
    // Rooms are unlisted, not private: the id is the only gate on reading (10/6 sync).
    assert.match(human, /Create an unlisted room/);
    assert.match(human, /Unlisted: anyone with the link can read\./);
    assert.equal(/private room/i.test(human), false);
    const docs = await (await fetch(`${base}/docs/protocol`)).text();
    assert.equal(/private (room|create)/i.test(docs), false);
  });

  it('ai is live API page without composer; open is live composition UI', async () => {
    const ai = await (await fetch(`${base}/ai`)).text();
    const open = await (await fetch(`${base}/open`)).text();
    assert.match(ai, /machines join through an API/i);
    assert.match(ai, /\/api\/ai/);
    assert.doesNotMatch(ai, /Not open for join yet/);
    assert.doesNotMatch(ai, /<textarea/);
    assert.match(open, /composition of Human and AI streams/i);
    assert.match(open, /Parties stay labeled/i);
    assert.match(open, /id="btn-join"/);
    assert.match(open, /<textarea/);
    assert.doesNotMatch(open, /Join surface not open yet/);
  });
});
