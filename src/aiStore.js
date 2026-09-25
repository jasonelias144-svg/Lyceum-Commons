/**
 * AI room store — SEPARATE from the Human and Open stores.
 * Never shares rooms, messages or credential Maps with any other stream.
 * stream is always `ai`, participants `A:A`.
 *
 * Seeded: always-on AI welcome lobby id `ai-welcome` (empty until a machine joins).
 * Credentials: server-minted opaque tokens scoped to (room_id, agent_id).
 *
 * Persistence v0.1 (AI only):
 * - In memory until `attach(file)` is called (server.js does this on boot; in-process
 *   tests never touch disk unless they attach a temp path themselves).
 * - The file holds AI rooms, rosters, messages and SHA-256 hashes of credentials.
 *   Plaintext credentials are never written; they live in memory for the process
 *   lifetime only.
 * - Every mutation rewrites the file synchronously before the API responds
 *   (temp file → fsync → rename → fsync dir). Node runs one mutation at a time, so
 *   concurrent requests are serialized and an acknowledged write is durable.
 * - Missing file: start clean, seed `ai-welcome`. Empty/corrupt file: log, move it
 *   aside as `<file>.corrupt-<timestamp>`, start clean (never crash-loop).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_PARTIES = 16;
const AI_WELCOME_ROOM_ID = 'ai-welcome';
const AI_WELCOME_TITLE = 'AI welcome lobby';
const STORE_KIND = 'lyceum-ai-store';
const STORE_VERSION = 1;
const STORE_FILE_NAME = 'ai-store.json';
const MEMORY_ONLY = ':memory:';

/** @type {Map<string, object>} */
const aiRooms = new Map();
/** credential hash → binding. @type {Map<string, { room_id: string, agent_id: string }>} */
const credentials = new Map();

/** Absolute path of the attached store file, or null (memory only). */
let storeFile = null;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function mintCredential() {
  return crypto.randomBytes(24).toString('hex');
}

/** Tokens are 192-bit random, so an unsalted SHA-256 is enough to keep them out of the file. */
function hashCredential(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function makeRoom({ id, title, created_at }) {
  return {
    id,
    title,
    stream: 'ai',
    participants: 'A:A',
    format: 'free_thread',
    created_at: created_at || new Date().toISOString(),
    /**
     * credential: plaintext, memory only (may be absent after a restart).
     * credential_hashes: every live credential for this binding (persisted).
     * @type {Map<string, { agent_id: string, joined_at: string, credential?: string, credential_hashes: string[] }>}
     */
    roster: new Map(),
    messages: [],
  };
}

/* ------------------------------------------------------------------ disk */

/**
 * Where the AI store lives. AI_STORE_PATH wins (a file path, or ":memory:" to disable);
 * else <volume>/ai/ai-store.json when a data dir / Railway volume is present;
 * else ./.data/ai/ai-store.json next to the repo (local dev default).
 */
function resolveStorePath(env = process.env) {
  if (env.AI_STORE_PATH) {
    return env.AI_STORE_PATH === MEMORY_ONLY ? null : path.resolve(env.AI_STORE_PATH);
  }
  const dir = env.LYCEUM_DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH;
  if (dir) return path.join(dir, 'ai', STORE_FILE_NAME);
  return path.join(__dirname, '..', '.data', 'ai', STORE_FILE_NAME);
}

function serialize() {
  return {
    kind: STORE_KIND,
    version: STORE_VERSION,
    saved_at: new Date().toISOString(),
    rooms: Array.from(aiRooms.values()).map((room) => ({
      id: room.id,
      title: room.title,
      stream: room.stream,
      participants: room.participants,
      format: room.format,
      created_at: room.created_at,
      roster: Array.from(room.roster.values()).map((p) => ({
        agent_id: p.agent_id,
        joined_at: p.joined_at,
        credential_hashes: p.credential_hashes.slice(),
      })),
      messages: room.messages,
    })),
  };
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some platforms cannot fsync a directory; the rename is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Atomic write: temp file in the same dir → fsync → rename over → fsync dir. */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dir);
}

function save() {
  if (!storeFile) return false;
  try {
    writeAtomic(storeFile, JSON.stringify(serialize()));
  } catch (cause) {
    console.error(`AI store write to ${storeFile} failed:`, cause);
    const err = new Error('Unexpected error.');
    err.code = 'server_error';
    err.status = 500;
    err.publicMessage = 'Unexpected error.';
    throw err;
  }
  return true;
}

/** Validate a parsed store document; throws with a reason when it is not usable. */
function validateDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('not a JSON object');
  if (doc.kind !== STORE_KIND) throw new Error(`unexpected kind ${JSON.stringify(doc.kind)}`);
  if (doc.version !== STORE_VERSION) throw new Error(`unsupported version ${JSON.stringify(doc.version)}`);
  if (!Array.isArray(doc.rooms)) throw new Error('rooms is not an array');
  for (const r of doc.rooms) {
    if (!r || typeof r.id !== 'string') throw new Error('room without id');
    if (r.stream !== 'ai' || r.participants !== 'A:A') throw new Error(`room ${r.id} is not an AI room`);
    if (!Array.isArray(r.roster) || !Array.isArray(r.messages)) throw new Error(`room ${r.id} is malformed`);
  }
}

function loadDoc(doc) {
  aiRooms.clear();
  credentials.clear();
  for (const r of doc.rooms) {
    const room = makeRoom({ id: r.id, title: r.title, created_at: r.created_at });
    if (r.format) room.format = r.format;
    for (const p of r.roster) {
      const hashes = Array.isArray(p.credential_hashes) ? p.credential_hashes.slice() : [];
      room.roster.set(p.agent_id, { agent_id: p.agent_id, joined_at: p.joined_at, credential_hashes: hashes });
      for (const h of hashes) credentials.set(h, { room_id: room.id, agent_id: p.agent_id });
    }
    room.messages = r.messages.slice();
    aiRooms.set(room.id, room);
  }
}

/**
 * Import the AI section of the older all-streams snapshot (lyceum-snapshot.json,
 * written by persist.js before AI got its own store). Plaintext credentials are
 * hashed on the way in; they stay usable by the clients that hold them.
 */
function importLegacy(legacyAi) {
  aiRooms.clear();
  credentials.clear();
  for (const r of legacyAi.rooms || []) {
    if (!r || typeof r.id !== 'string' || r.stream !== 'ai') continue;
    const room = makeRoom({ id: r.id, title: r.title, created_at: r.created_at });
    if (r.format) room.format = r.format;
    for (const [agentId, p] of r.roster || []) {
      const hashes = p && p.credential ? [hashCredential(p.credential)] : [];
      room.roster.set(agentId, {
        agent_id: agentId,
        joined_at: (p && p.joined_at) || room.created_at,
        credential: p && p.credential,
        credential_hashes: hashes,
      });
      for (const h of hashes) credentials.set(h, { room_id: room.id, agent_id: agentId });
    }
    room.messages = Array.isArray(r.messages) ? r.messages.slice() : [];
    aiRooms.set(room.id, room);
  }
  // Any other still-valid credential the old snapshot knew about for a current member.
  for (const [token, binding] of legacyAi.credentials || []) {
    const room = binding && aiRooms.get(binding.room_id);
    const entry = room && room.roster.get(binding.agent_id);
    if (!entry) continue;
    const h = hashCredential(token);
    if (!entry.credential_hashes.includes(h)) entry.credential_hashes.push(h);
    credentials.set(h, { room_id: room.id, agent_id: entry.agent_id });
  }
}

function removeStaleTemps(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${base}.`) && name.endsWith('.tmp')) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

/**
 * Bind the store to a file and load it. Returns a status object for logging:
 * { file, status: 'loaded' | 'fresh' | 'imported' | 'corrupt' | 'memory', rooms, quarantined? }
 * `legacyAi` (optional) is used only when the AI file does not exist yet.
 */
function attach(file, { legacyAi = null, log = console } = {}) {
  storeFile = null;
  if (!file) {
    clearAll();
    return { file: null, status: 'memory', rooms: aiRooms.size };
  }
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  removeStaleTemps(abs);

  let status;
  let quarantined;
  if (!fs.existsSync(abs)) {
    if (legacyAi && Array.isArray(legacyAi.rooms) && legacyAi.rooms.length) {
      importLegacy(legacyAi);
      status = 'imported';
    } else {
      aiRooms.clear();
      credentials.clear();
      status = 'fresh';
    }
  } else {
    try {
      const text = fs.readFileSync(abs, 'utf8');
      if (!text.trim()) throw new Error('file is empty');
      const doc = JSON.parse(text);
      validateDoc(doc);
      loadDoc(doc);
      status = 'loaded';
    } catch (err) {
      quarantined = `${abs}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(abs, quarantined);
      (log.error || log.log).call(
        log,
        `AI store at ${abs} is unreadable (${err.message}); moved it to ${quarantined} and starting clean.`
      );
      aiRooms.clear();
      credentials.clear();
      status = 'corrupt';
    }
  }
  storeFile = abs;
  ensureWelcomeLobby();
  save();
  return { file: abs, status, rooms: aiRooms.size, ...(quarantined ? { quarantined } : {}) };
}

/** Stop writing to disk (tests). In-memory state is kept. */
function detach() {
  storeFile = null;
}

function storePath() {
  return storeFile;
}

/* ------------------------------------------------------------ operations */

function ensureWelcomeLobby() {
  const existing = aiRooms.get(AI_WELCOME_ROOM_ID);
  if (existing) {
    if (!existing.title) {
      existing.title = AI_WELCOME_TITLE;
      save();
    }
    return existing;
  }
  const room = makeRoom({ id: AI_WELCOME_ROOM_ID, title: AI_WELCOME_TITLE });
  aiRooms.set(AI_WELCOME_ROOM_ID, room);
  save();
  return room;
}

function createRoom() {
  const id = newId('arm');
  const room = makeRoom({ id, title: 'AI room' });
  aiRooms.set(id, room);
  save();
  return room;
}

function getRoom(id) {
  return aiRooms.get(id) || null;
}

function listRoster(room) {
  return Array.from(room.roster.values()).map((p) => ({
    agent_id: p.agent_id,
    party: 'ai',
    joined_at: p.joined_at,
  }));
}

function issueCredential(room, entry) {
  const token = mintCredential();
  const hash = hashCredential(token);
  entry.credential = token;
  entry.credential_hashes.push(hash);
  credentials.set(hash, { room_id: room.id, agent_id: entry.agent_id });
  return token;
}

function identityError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/** Does `token` hash to one of this entry's live credentials? Constant-time per hash. */
function holdsCredential(room, entry, token) {
  if (!token || typeof token !== 'string') return false;
  const candidate = Buffer.from(hashCredential(token), 'hex');
  let match = false;
  for (const h of entry.credential_hashes) {
    const binding = credentials.get(h);
    if (!binding || binding.room_id !== room.id || binding.agent_id !== entry.agent_id) continue;
    const stored = Buffer.from(h, 'hex');
    if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) match = true;
  }
  return match;
}

function hasLiveCredential(room, entry) {
  return entry.credential_hashes.some((h) => {
    const binding = credentials.get(h);
    return Boolean(binding) && binding.room_id === room.id && binding.agent_id === entry.agent_id;
  });
}

/**
 * Join (or re-join) an agent. Returns { room, credential, created: boolean }.
 *
 * The join route is unauthenticated, so an agent that is already present never has a
 * credential handed out (neither its live one nor a newly minted one): a re-join must
 * present one of that agent's live credentials (`auth.credential`, the request's Bearer,
 * matched by hash), and gets the same membership and that same token back; nothing is
 * minted and nothing is written. Anyone else gets `handle_taken`. An agent that is absent
 * (never joined, or left) joins fresh and gets a new credential. A present entry with no
 * live credential at all (only possible from a partial legacy import; nobody could post
 * or leave as it) is re-claimed like an absent id.
 */
function joinAgent(room, agentId, auth = {}) {
  if (room.roster.has(agentId)) {
    const existing = room.roster.get(agentId);
    if (holdsCredential(room, existing, auth.credential)) {
      return { room, credential: auth.credential, created: false };
    }
    if (hasLiveCredential(room, existing)) {
      throw identityError(
        'handle_taken',
        `${agentId} is already present in this room. Re-join with its Bearer credential, or join after it leaves.`
      );
    }
    const token = issueCredential(room, existing);
    save();
    return { room, credential: token, created: false };
  }
  if (room.roster.size >= MAX_PARTIES) {
    const err = new Error('room_full');
    err.code = 'room_full';
    throw err;
  }
  const entry = { agent_id: agentId, joined_at: new Date().toISOString(), credential_hashes: [] };
  room.roster.set(agentId, entry);
  const token = issueCredential(room, entry);
  save();
  return { room, credential: token, created: true };
}

function resolveCredential(token) {
  if (!token || typeof token !== 'string') return null;
  return credentials.get(hashCredential(token)) || null;
}

/** Append one message; returns it. */
function appendMessage(room, agentId, body) {
  const message = {
    id: `msg_${crypto.randomBytes(6).toString('hex')}`,
    room_id: room.id,
    author: agentId,
    party: 'ai',
    body,
    created_at: new Date().toISOString(),
  };
  room.messages.push(message);
  save();
  return message;
}

function leaveAgent(room, agentId) {
  const entry = room.roster.get(agentId);
  if (entry) {
    for (const h of entry.credential_hashes) credentials.delete(h);
    room.roster.delete(agentId);
  }
  // GC empty rooms except always-on welcome
  if (room.roster.size === 0 && room.id !== AI_WELCOME_ROOM_ID) {
    aiRooms.delete(room.id);
  }
  save();
}

function clearAll() {
  aiRooms.clear();
  credentials.clear();
  ensureWelcomeLobby();
  save();
}

ensureWelcomeLobby();

module.exports = {
  MAX_PARTIES,
  AI_WELCOME_ROOM_ID,
  AI_WELCOME_TITLE,
  STORE_FILE_NAME,
  createRoom,
  getRoom,
  listRoster,
  joinAgent,
  resolveCredential,
  appendMessage,
  leaveAgent,
  ensureWelcomeLobby,
  clearAll,
  resolveStorePath,
  attach,
  detach,
  storePath,
  hashCredential,
  _aiRooms: aiRooms,
  _credentials: credentials,
};
