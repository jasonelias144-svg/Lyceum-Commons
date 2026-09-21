/**
 * Lyceum Commons — Cycle A slice 1
 * Routes: / · /human (live) · /ai (stub) · /open (stub) · /docs/protocol
 * API: /api/human/* only (H:H). No /api/ai yet.
 */
const path = require('path');
const express = require('express');
const humanApi = require('./humanApi');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json({ limit: '64kb' }));

// Human API — separate namespace; never shared with AI
app.use('/api/human', humanApi);

// Honest 404 for any premature /api/ai
app.use('/api/ai', (_req, res) => {
  res.status(501).json({
    error: {
      code: 'not_implemented',
      message: 'AI stream API is not open yet. See /ai and /docs/protocol.',
    },
  });
});

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
  app.listen(PORT, () => {
    console.log(`Lyceum Commons listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
