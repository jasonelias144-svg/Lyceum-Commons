/**
 * Test helper: acts like one browser per human name. It remembers the guest_key a human join
 * returns and sends it as X-Lyceum-Guest on later Open or Human calls made as that handle
 * (body.handle or ?handle=), unless the call already carries a Bearer or its own guest header.
 * Keys are kept per stream (an Open key means nothing to /api/human, and the other way round).
 * Tests that probe keyless or wrong-key calls pass their own headers or use a handle the jar
 * has not seen.
 */
const keys = new Map();

/** 'open' or 'human' for the two APIs that issue guest keys, else null. */
function streamOf(path) {
  if (path.startsWith('/api/open')) return 'open';
  if (path.startsWith('/api/human')) return 'human';
  return null;
}

function handleOf(path, body) {
  if (body && typeof body.handle === 'string') return body.handle.trim();
  const query = path.split('?')[1];
  if (!query) return null;
  const h = new URLSearchParams(query).get('handle');
  return h ? h.trim() : null;
}

function guestHeaders(path, body, headers = {}) {
  const stream = streamOf(path);
  if (!stream) return {};
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  if (names.includes('authorization') || names.includes('x-lyceum-guest')) return {};
  const handle = handleOf(path, body);
  const key = handle !== null ? keys.get(`${stream}:${handle}`) : undefined;
  return key ? { 'X-Lyceum-Guest': key } : {};
}

function remember(path, body, data) {
  if (!data || !data.guest_key) return;
  const stream = streamOf(path);
  const handle = handleOf(path, body);
  if (stream && handle !== null) keys.set(`${stream}:${handle}`, data.guest_key);
}

/** The remembered key for a handle; stream defaults to 'open' (as before Human had keys). */
function keyFor(handle, stream = 'open') {
  return keys.get(`${stream}:${handle}`);
}

module.exports = { guestHeaders, remember, keyFor };
