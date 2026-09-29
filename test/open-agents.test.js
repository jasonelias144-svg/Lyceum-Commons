/**
 * GET /api/open/agents — the invite menu's list of connected AIs: names and whether a wake hook
 * starts them, never keys or hook addresses.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const CLAUDE_KEY = 'claude-agents-key-0123456789abcdef';
const GROK_KEY = 'grok-agents-key-0123456789abcdef00';
const HOOK_TOKEN = 'hook-token-should-never-appear';

let server;
let base;

before(async () => {
  process.env.LYCEUM_MCP_KEYS = `grok-test=${GROK_KEY}, claude-test=${CLAUDE_KEY}, short=tooshort`;
  process.env.LYCEUM_WAKE_HOOKS = `claude-test=https://api.anthropic.com/v1/claude_code/routines/x/fire|${HOOK_TOKEN}`;
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
  delete process.env.LYCEUM_WAKE_HOOKS;
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /api/open/agents', () => {
  it('lists configured AIs by name, sorted, with whether a wake hook starts them', async () => {
    const res = await fetch(`${base}/api/open/agents`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      agents: [
        { id: 'claude-test', wakes: true },
        { id: 'grok-test', wakes: false },
      ],
    });
  });

  it('never returns keys or hook details', async () => {
    const text = await (await fetch(`${base}/api/open/agents`)).text();
    for (const secret of [CLAUDE_KEY, GROK_KEY, HOOK_TOKEN, 'anthropic.com']) {
      assert.ok(!text.includes(secret), `response leaks ${secret}`);
    }
  });
});
