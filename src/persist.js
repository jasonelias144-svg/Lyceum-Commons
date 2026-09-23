/**
 * Snapshot persistence — keeps rooms, messages, rosters, credentials and the guest
 * book across restarts by writing all four in-memory stores to one JSON file.
 *
 * Where: LYCEUM_DATA_DIR, else RAILWAY_VOLUME_MOUNT_PATH (set automatically when a
 * Railway Volume is attached). Neither set → in-memory only, as before.
 *
 * When: every state change arrives as a non-GET request, so a save is scheduled
 * (debounced) when such a request finishes, and once more on SIGTERM/SIGINT.
 * Writes go to a temp file that is renamed over the old one, so a crash mid-write
 * never leaves a half-written snapshot.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const aiStore = require('./aiStore');
const openStore = require('./openStore');
const notify = require('./notify');

const FILE_NAME = 'lyceum-snapshot.json';
const VERSION = 1;
const DEBOUNCE_MS = 500;

function dataDir() {
  return process.env.LYCEUM_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
}

function snapshotPath() {
  const dir = dataDir();
  return dir ? path.join(dir, FILE_NAME) : null;
}

function roomsOut(map) {
  return Array.from(map.values()).map((room) => ({
    ...room,
    roster: Array.from(room.roster.entries()),
  }));
}

function roomsIn(map, list) {
  map.clear();
  for (const room of list || []) {
    map.set(room.id, { ...room, roster: new Map(room.roster || []) });
  }
}

function mapIn(map, entries) {
  map.clear();
  for (const [k, v] of entries || []) map.set(k, v);
}

function serialize() {
  return {
    version: VERSION,
    saved_at: new Date().toISOString(),
    human: { rooms: roomsOut(store._rooms), guestbook: store._getGuestbook() },
    ai: { rooms: roomsOut(aiStore._aiRooms), credentials: Array.from(aiStore._credentials.entries()) },
    open: {
      rooms: roomsOut(openStore._openRooms),
      credentials: Array.from(openStore._credentials.entries()),
      webhooks: Array.from(notify._subscriptions.values()).map((s) => ({ ...s, sent: [] })),
    },
  };
}

/** Replace all store contents with a snapshot, then make sure the seeded rooms exist. */
function restore(snap) {
  if (!snap || snap.version !== VERSION) {
    throw new Error(`Unsupported snapshot version: ${snap && snap.version}`);
  }
  roomsIn(store._rooms, snap.human && snap.human.rooms);
  store._setGuestbook((snap.human && snap.human.guestbook) || []);
  roomsIn(aiStore._aiRooms, snap.ai && snap.ai.rooms);
  mapIn(aiStore._credentials, snap.ai && snap.ai.credentials);
  roomsIn(openStore._openRooms, snap.open && snap.open.rooms);
  mapIn(openStore._credentials, snap.open && snap.open.credentials);
  notify._subscriptions.clear();
  for (const sub of (snap.open && snap.open.webhooks) || []) notify._subscriptions.set(sub.id, sub);
  store.ensureSeededRooms();
  aiStore.ensureWelcomeLobby();
  openStore.ensureWelcomeLobby();
}

/** Load the snapshot if there is one. Returns true when state was restored. */
function load() {
  const file = snapshotPath();
  if (!file || !fs.existsSync(file)) return false;
  restore(JSON.parse(fs.readFileSync(file, 'utf8')));
  return true;
}

function saveNow() {
  const file = snapshotPath();
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serialize()));
  fs.renameSync(tmp, file);
  return true;
}

let timer = null;

function scheduleSave() {
  if (!snapshotPath() || timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      saveNow();
    } catch (err) {
      console.error('Snapshot save failed:', err);
    }
  }, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
}

/** Express middleware: schedule a save after every request that can change state. */
function middleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', scheduleSave);
  }
  next();
}

/** Save on shutdown (Railway sends SIGTERM before replacing the service). */
function installShutdownHooks() {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      if (timer) clearTimeout(timer);
      try {
        saveNow();
      } catch (err) {
        console.error('Snapshot save on shutdown failed:', err);
      }
      process.exit(0);
    });
  }
}

module.exports = {
  dataDir,
  snapshotPath,
  serialize,
  restore,
  load,
  saveNow,
  scheduleSave,
  middleware,
  installShutdownHooks,
};
