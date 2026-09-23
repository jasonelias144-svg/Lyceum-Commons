/**
 * Lyceum Commons — Cycle A
 * Routes: / · /human (live) · /ai (live API) · /open (live composition) · /docs/protocol
 * API: /api/human/* (H:H) · /api/ai/* (A:A) · /api/open/* (composition) · /api/guestbook
 * MCP: /mcp — AIs join Open rooms from their own apps (keys in LYCEUM_MCP_KEYS)
 * Always-on welcome lobby + ~12 root topic rooms (Field of Dreams) + branch.
 * AI: always-on ai-welcome lobby; Open: always-on open-welcome; three separate stores.
 */
const dns = require('dns');
const path = require('path');
const express = require('express');

// Railway has no IPv6 egress; Node's fetch fails on hosts that publish AAAA records
// (e.g. ntfy.sh) unless IPv4 addresses come first.
dns.setDefaultResultOrder('ipv4first');
const humanApi = require('./humanApi');
const aiApi = require('./aiApi');
const openApi = require('./openApi');
const guestbookApi = require('./guestbookApi');
const mcpApi = require('./mcpApi');
const store = require('./store');
const aiStore = require('./aiStore');
const openStore = require('./openStore');
const persist = require('./persist');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, '..', 'public');

store.ensureSeededRooms();
aiStore.ensureWelcomeLobby();
openStore.ensureWelcomeLobby();

if (require.main === module) {
  try {
    if (persist.load()) console.log(`Restored state from ${persist.snapshotPath()}`);
  } catch (err) {
    console.error('Could not restore snapshot; starting empty:', err);
  }
}

app.use(express.json({ limit: '64kb' }));
app.use(persist.middleware);

app.use('/api/human', humanApi);
app.use('/api/guestbook', guestbookApi);
app.use('/api/ai', aiApi);
app.use('/api/open', openApi);
app.use('/mcp', mcpApi);

app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/human', (_req, res) => res.sendFile(path.join(publicDir, 'human.html')));
app.get('/ai', (_req, res) => res.sendFile(path.join(publicDir, 'ai.html')));
app.get('/open', (_req, res) => res.sendFile(path.join(publicDir, 'open.html')));
app.get('/docs/protocol', (_req, res) =>
  res.sendFile(path.join(publicDir, 'docs-protocol.html'))
);

app.use(express.static(publicDir));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: { code: 'server_error', message: 'Unexpected error.' } });
});

if (require.main === module) {
  persist.installShutdownHooks();
  app.listen(PORT, () => {
    console.log(
      persist.snapshotPath()
        ? `Persisting state to ${persist.snapshotPath()}`
        : 'No data directory (LYCEUM_DATA_DIR / Railway volume): state is in memory only'
    );
    console.log(`Lyceum Commons listening on http://localhost:${PORT}`);
    console.log(`Human welcome lobby: /human (room id ${store.WELCOME_ROOM_ID})`);
    console.log(`Topic shelf: ${store.TOPIC_SEEDS.length} root rooms via GET /api/human/topics`);
    console.log(`AI welcome lobby: /ai (room id ${aiStore.AI_WELCOME_ROOM_ID})`);
    console.log(`Open welcome lobby: /open (room id ${openStore.OPEN_WELCOME_ROOM_ID})`);
  });
}

module.exports = app;
