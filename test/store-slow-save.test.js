/**
 * Slow-save warning: every store save (the AI store's writeAtomic and the shared snapshot) is
 * timed, and one slower than STORE_SLOW_SAVE_MS (default 500) logs one WARNING line. Time is
 * injected with slowSave._setClock, so no disk has to be slow. Also: the two /human notes read
 * before acting use --muted, which clears 4.5:1 on the panel colour.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const slowSave = require('../src/slowSave');
const aiStore = require('../src/aiStore');
const persist = require('../src/persist');

let warnings;
let realWarn;
let t;

/** Clock that moves `step` ms each time it is read (one read before the save, one after). */
function steppingClock(step) {
  t = 1_000_000;
  slowSave._setClock(() => {
    const now = t;
    t += step;
    return now;
  });
}

beforeEach(() => {
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  delete process.env.STORE_SLOW_SAVE_MS;
});

afterEach(() => {
  console.warn = realWarn;
  slowSave._setClock();
  delete process.env.STORE_SLOW_SAVE_MS;
});

describe('Slow-save warning', () => {
  it('warns once, in the WARNING style, when a save takes longer than the 500 ms default', () => {
    steppingClock(501);
    const out = slowSave.timedSave('/data/ai/ai-store.json', () => 'saved');
    assert.equal(out, 'saved');
    assert.deepEqual(warnings, [
      '[store] WARNING: slow save of /data/ai/ai-store.json took 501 ms (threshold 500 ms)',
    ]);
  });

  it('says nothing at or under the threshold', () => {
    steppingClock(500);
    slowSave.timedSave('/x.json', () => true);
    steppingClock(3);
    slowSave.timedSave('/x.json', () => true);
    assert.deepEqual(warnings, []);
  });

  it('STORE_SLOW_SAVE_MS overrides the threshold; 0 turns the warning off', () => {
    process.env.STORE_SLOW_SAVE_MS = '100';
    assert.equal(slowSave.slowSaveThresholdMs(), 100);
    steppingClock(150);
    slowSave.timedSave('/x.json', () => true);
    assert.deepEqual(warnings, ['[store] WARNING: slow save of /x.json took 150 ms (threshold 100 ms)']);

    warnings.length = 0;
    process.env.STORE_SLOW_SAVE_MS = '0';
    steppingClock(60_000);
    slowSave.timedSave('/x.json', () => true);
    assert.deepEqual(warnings, []);
  });

  it('a bad value falls back to the default with one WARNING', () => {
    for (const bad of ['abc', '-5', '1.5', ' 200']) {
      warnings.length = 0;
      process.env.STORE_SLOW_SAVE_MS = bad;
      assert.equal(slowSave.slowSaveThresholdMs(), slowSave.DEFAULT_SLOW_SAVE_MS, bad);
      assert.equal(slowSave.slowSaveThresholdMs(), slowSave.DEFAULT_SLOW_SAVE_MS, bad);
      assert.deepEqual(warnings, [
        `[store] WARNING: STORE_SLOW_SAVE_MS=${JSON.stringify(bad)} is not a whole number of ms; using the default 500.`,
      ]);
    }
  });

  it('does not change save semantics: errors still propagate (and a slow failure still warns)', () => {
    steppingClock(900);
    const boom = new Error('disk gone');
    assert.throws(() => slowSave.timedSave('/x.json', () => { throw boom; }), (err) => err === boom);
    assert.deepEqual(warnings, ['[store] WARNING: slow save of /x.json took 900 ms (threshold 500 ms)']);
  });

  it('the AI store save path (writeAtomic) is timed, and the file is still written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyceum-slow-ai-'));
    const file = path.join(dir, 'ai-store.json');
    try {
      aiStore.attach(file, { log: { log() {}, warn() {}, error() {} } });
      warnings.length = 0;
      steppingClock(1200);
      const room = aiStore.createRoom();
      assert.deepEqual(warnings, [`[store] WARNING: slow save of ${file} took 1200 ms (threshold 500 ms)`]);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(doc.rooms.some((r) => r.id === room.id));

      warnings.length = 0;
      steppingClock(10);
      aiStore.createRoom();
      assert.deepEqual(warnings, []);
    } finally {
      aiStore.detach();
      aiStore.clearAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the Human/Open snapshot save is timed too, and still written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyceum-slow-snap-'));
    const was = process.env.LYCEUM_DATA_DIR;
    process.env.LYCEUM_DATA_DIR = dir;
    try {
      steppingClock(700);
      assert.equal(persist.saveNow(), true);
      const file = path.join(dir, 'lyceum-snapshot.json');
      assert.deepEqual(warnings, [`[store] WARNING: slow save of ${file} took 700 ms (threshold 500 ms)`]);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
    } finally {
      if (was === undefined) delete process.env.LYCEUM_DATA_DIR;
      else process.env.LYCEUM_DATA_DIR = was;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('/human note contrast', () => {
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'human.html'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'css', 'site.css'), 'utf8');

  function luminance(hex) {
    const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c).slice(1) : hex.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it('the guest note and the Unlisted line use --muted', () => {
    for (const text of ["You're joining as a guest.", 'Unlisted: anyone with the link can read.']) {
      const p = html.match(new RegExp(`<p class="([^"]+)">${text.replace(/[.]/g, '\\.')}`));
      assert.ok(p, text);
      assert.ok(p[1].split(' ').includes('limit-note-muted'), `${text} → ${p[1]}`);
    }
    assert.match(css, /\.limit-note-muted\s*\{\s*color:\s*var\(--muted\);\s*\}/);
    // It comes after .limit-note (same specificity), so it wins over --faint.
    assert.ok(css.indexOf('.limit-note-muted') > css.indexOf('.limit-note {'));
  });

  it('--muted is at least 4.5:1 on the panel colour in both schemes', () => {
    const dark = css.slice(0, css.indexOf('@media (prefers-color-scheme: light)'));
    const light = css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
    for (const block of [dark, light]) {
      const muted = block.match(/--muted:\s*(#[0-9a-f]{3,6})/i)[1];
      const surface = block.match(/--surface:\s*(#[0-9a-f]{3,6})/i)[1];
      assert.ok(ratio(muted, surface) >= 4.5, `${muted} on ${surface}: ${ratio(muted, surface).toFixed(2)}`);
    }
    assert.match(dark, /--surface:\s*#111;/);
  });
});
