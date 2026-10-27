/**
 * Cloudflare Workers entry point (stage 1 of docs/cloudflare-port.md).
 *
 * The Worker is stateless. Static files come from the assets binding; the page
 * routes (/human, /open, ...) are mapped to their HTML files here, because the
 * Express app's sendFile cannot read files on Workers. Everything else goes to
 * one Durable Object, which runs the unchanged Express app from src/server.js,
 * so all state lives in a single instance, as it does in the Node process.
 *
 * Stage 1 keeps state in memory only: it resets whenever the object restarts.
 * Persistence to the object's SQLite storage is stage 2.
 */
import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import app from './server.js';

const PORT = 3000;

// Register the Express app once per isolate, under PORT. Nothing binds a socket on
// Workers: handleAsNodeRequest routes requests to whatever is registered there.
app.listen(PORT);

/**
 * Page routes whose path differs from their file. The static-asset layer already
 * serves /, /human, /ai, /open and /guests from the matching .html files.
 */
const PAGES = {
  '/docs/protocol': '/docs-protocol',
};

export class Lyceum extends DurableObject {
  async fetch(request) {
    return handleAsNodeRequest(PORT, request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const page = PAGES[url.pathname];
    if (page && (request.method === 'GET' || request.method === 'HEAD')) {
      return env.ASSETS.fetch(new Request(new URL(page, url), request));
    }
    const stub = env.LYCEUM.get(env.LYCEUM.idFromName('lyceum'));
    return stub.fetch(request);
  },
};
