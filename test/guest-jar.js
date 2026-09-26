/**
 * Test helper: acts like one browser per human name. It remembers the guest_key a human join
 * returns and sends it as X-Lyceum-Guest on later Open calls made as that handle (body.handle
 * or ?handle=), unless the call already carries a Bearer or its own guest header. Tests that
 * probe keyless or wrong-key calls pass their own headers or use a handle the jar has not seen.
 */
const keys = new Map();

function handleOf(path, body) {
  if (body && typeof body.handle === 'string') return body.handle.trim();
  const query = path.split('?')[1];
  if (!query) return null;
  const h = new URLSearchParams(query).get('handle');
  return h ? h.trim() : null;
}

function guestHeaders(path, body, headers = {}) {
  if (!path.startsWith('/api/open')) return {};
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  if (names.includes('authorization') || names.includes('x-lyceum-guest')) return {};
  const handle = handleOf(path, body);
  const key = handle !== null ? keys.get(handle) : undefined;
  return key ? { 'X-Lyceum-Guest': key } : {};
}

function remember(path, body, data) {
  if (!data || !data.guest_key) return;
  const handle = handleOf(path, body);
  if (handle !== null) keys.set(handle, data.guest_key);
}

module.exports = { guestHeaders, remember, keyFor: (handle) => keys.get(handle) };
