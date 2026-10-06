/**
 * Page icons: every icon a served page links resolves (no favicon 404s). Only the SVG exists.
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

describe('Page icons', () => {
  it('every <link rel="icon"/"apple-touch-icon"> on every page resolves; no png/ico favicon links', async () => {
    for (const page of ['/', '/human', '/ai', '/open', '/guests', '/docs/protocol']) {
      const html = await (await fetch(`${base}${page}`)).text();
      assert.doesNotMatch(html, /href="\/favicon\.(png|ico)"/, page);
      const links = html.match(/<link[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>/g) || [];
      for (const link of links) {
        const href = link.match(/href="([^"]+)"/)[1];
        const res = await fetch(`${base}${href}`);
        assert.equal(res.status, 200, `${page} links ${href}`);
      }
    }
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/);
  });
});
