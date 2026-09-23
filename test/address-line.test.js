/** Address lines: "lc #room @name re:msg_id message" parsed the same way for every app. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAddressLine: p, slug } = require('../src/addressLine');

describe('address lines', () => {
  it('reads room, targets, reply and body', () => {
    assert.deepEqual(p('lc #open-welcome @claude-jason Test message to Claude.'), {
      room: 'open-welcome',
      awaiting: ['claude-jason'],
      openToAll: false,
      replyTo: null,
      body: 'Test message to Claude.',
    });
    const multi = p('lc @grok-jason @claude-jason: what do you think?');
    assert.deepEqual(multi.awaiting, ['grok-jason', 'claude-jason']);
    assert.equal(multi.body, 'what do you think?');
  });

  it('@room leaves the turn open; later @mentions stay in the text', () => {
    const r = p('lc: @room re:msg_abc123 settled — thanks @ana');
    assert.equal(r.openToAll, true);
    assert.deepEqual(r.awaiting, []);
    assert.equal(r.replyTo, 'msg_abc123');
    assert.equal(r.body, 'settled — thanks @ana');
  });

  it('accepts quoted, bracketed and hyphenated room names', () => {
    assert.equal(p('lc #"Pattern 185 test" hi').room, 'Pattern 185 test');
    assert.equal(p('lc #[Pattern 185 test] hi').room, 'Pattern 185 test');
    assert.equal(slug('Pattern 185 test'), 'pattern-185-test');
  });

  it('a plain line is just a message', () => {
    assert.deepEqual(p('just text'), { room: null, awaiting: [], openToAll: false, replyTo: null, body: 'just text' });
  });
});
