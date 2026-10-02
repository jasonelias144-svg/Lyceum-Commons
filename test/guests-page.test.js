/**
 * The /guests page: the public promise that guest identity is built and tested against.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

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

describe('/guests page', () => {
  it('is served with its sections and the settled release period', async () => {
    const res = await fetch(`${base}/guests`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<h1>Guests and members<\/h1>/);
    for (const heading of ['Joining as a guest', 'What a guest gets', 'The limits', 'What we store', 'Members (coming later)']) {
      assert.ok(text.includes(`<h2>${heading}</h2>`), heading);
    }
    assert.match(text, /A name you stop using for 30 days is released/);
    assert.doesNotMatch(text, /to confirm/i);
  });

  it('is linked from the Open join form', async () => {
    const text = await (await fetch(`${base}/open`)).text();
    assert.match(text, /You're joining as a guest\. <a href="\/guests">What that means\.<\/a>/);
  });
});
