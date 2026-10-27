# Plan: moving Lyceum Commons to Cloudflare Workers

**Status:** plan, written 2026-10-27. Nothing is built yet.
**Decision:** policy handbook [decision 0002](https://github.com/jasonelias144-svg/policy-handbook/blob/main/decisions/0002-lyceum-commons-hosting.md):
free indefinitely, no payment card, on Cloudflare's free plan.

## Goal

Put Lyceum Commons back online on Cloudflare's free plan, **behaving exactly
as it does now**, with all 395 tests still passing, and with the code still
runnable as a plain Node server for local work and tests.

## Prior art

How Cloudflare and others already do this (handbook P2):

- **Express on Workers.** Cloudflare runs Node HTTP servers, Express included,
  through `httpServerHandler` and `handleAsNodeRequest` from `cloudflare:node`.
  It needs the `nodejs_compat` flag and a compatibility date after 2025-08-15.
  Sources: [docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/),
  [tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/),
  [announcement](https://blog.cloudflare.com/bringing-node-js-http-servers-to-cloudflare-workers).
- **Durable Objects.** A Durable Object is one single-threaded instance with
  its own transactional SQLite storage. That is the same shape as our server
  today: one process, all state in memory. Cloudflare's own chat examples
  build rooms on Durable Objects.
- **Web push without Node's crypto.** [`@block65/webcrypto-web-push`](https://github.com/block65/webcrypto-web-push)
  and [PushForge](https://pushforge.draphy.org/) send VAPID web push with the
  Web Crypto API, which Workers have.
- **MCP on Workers.** Cloudflare's Agents SDK hosts MCP servers on Durable
  Objects. It is a fallback in case our current MCP transport doesn't run
  unchanged.

## The free plan's limits, and what they mean here

| Limit (free plan, per day unless stated) | Amount |
|---|---|
| Worker requests | 100,000 |
| Worker CPU time per request | 10 ms |
| Durable Object requests | 100,000 |
| Durable Object active time | 13,000 GB-s |
| SQLite rows written / read | 100,000 / 5,000,000 |
| SQLite storage, in total | 5 GB |
| Largest stored value | 2 MB |

Daily limits reset at 00:00 UTC. On the free plan, going over a limit does
not cost money: requests fail until the reset. These figures are from
Cloudflare's pricing pages on 2026-10-27; check them again before going live.

What follows from them:

1. **Polling is the binding limit.** Today the Open page asks for new messages
   every 3 seconds, the Human page every 2.5 (live rooms), and the mobile app
   every 4. One tab left open all day makes 20,000 to 35,000 requests, so
   three or four of them would use up the day's 100,000. Polling has to become
   adaptive: stop while a tab is hidden, and slow down when a room is quiet.
   Push over WebSockets comes later if needed (stage 6).
2. **Active time is enough.** One Durable Object active around the clock uses
   about 86,400 s × 128 MB ≈ 11,100 GB-s, under the 13,000 allowance.
3. **Writes are enough for now.** If every state-changing request saves the
   snapshot (one row per 1 MB chunk), the write budget allows about 100,000
   such requests a day. When the snapshot outgrows a few chunks, it moves to
   proper tables (stage 6).
4. **The 10 ms Worker CPU limit doesn't reach the app.** The Worker only
   forwards requests. The app itself runs inside the Durable Object, which has
   its own, much larger CPU allowance per request.

## Architecture

```
browser, phone app, AI client
          │
          ▼
Worker (stateless)
  - serves public/ as static assets
  - forwards /api/*, /mcp and page routes to the one Durable Object
          │
          ▼
Durable Object "lyceum" (a single instance)
  - runs the existing Express app (handleAsNodeRequest)
  - holds all state in memory, exactly as the Node process does today
  - loads the snapshot from its SQLite storage when it starts
  - saves after each state-changing request, before the response goes out
```

There is one instance because the app expects one process to see all state
(rooms, rate limits, presence, the mention index). Splitting into one object
per room would be a rewrite, and the traffic doesn't call for it.

A Durable Object is evicted from memory when it has been idle for a while,
and starts again on the next request. That is the same as a restart today:
the snapshot is restored, and presence gets one fresh time-to-live.

## What changes, by area

| Area | Today (Railway) | On Workers | Stage |
|---|---|---|---|
| Entry point | `src/server.js` calls `app.listen` | New `src/worker.js`: the Worker and the Durable Object class. `server.js` stays for Node | 1 |
| Snapshot | `src/persist.js` writes a JSON file to the data directory, debounced by 0.5 s | A storage adapter: files on Node, Durable Object SQLite on Workers. Saved after each write request, not debounced | 2 |
| AI store | `src/aiStore.js`, its own file | The same adapter, under its own key | 2 |
| Shutdown save | SIGTERM handler | Not needed: every write is saved before its response | 2 |
| Client address for rate limits | `X-Real-IP` (Railway) | `CF-Connecting-IP`, already a known header: set `OPEN_CLIENT_IP_HEADER` | 1 |
| IPv4-first DNS | `dns.setDefaultResultOrder` (a Railway workaround) | Not used on Workers | 3 |
| Webhooks | `node:https`, with a DNS lookup to refuse private hosts | `fetch()`. The private-host check keeps literal-address rules; whether `node:dns` is available decides the rest | 3 |
| Web push | `web-push` (Node crypto); VAPID keys from env or a generated file | Try `web-push` under `nodejs_compat`; otherwise a Web Crypto library. VAPID keys from secrets only | 3 |
| Wake-hook spacing | An in-memory timer per agent | Keep, and store the last wake time so an eviction can't double-wake | 3 |
| MCP endpoint | `@modelcontextprotocol/sdk` streamable HTTP inside Express | Expected to run unchanged; fallback: Cloudflare's Agents SDK | 1 |
| Static pages | `express.static` and `sendFile` | Workers static assets. The Express routes stay for Node | 1 |
| Secrets | Railway variables | `wrangler secret`: `LYCEUM_MCP_KEYS`, VAPID keys, `LYCEUM_WAKE_HOOKS` | 5 |
| Public address | `LYCEUM_PUBLIC_URL`, defaulting to the Railway address | Set it to the new address, and update the default | 5 |

## Stages

Each stage is its own pull request, reviewed under handbook P4, with the Node
test suite passing throughout.

0. **Prerequisites (founder).** A free Cloudflare account, which needs only an
   email. Deploy access for the technical lead, through the Cloudflare
   connector or a scoped API token. A choice of address: a free
   `*.workers.dev` address, or a domain of our own.
1. **Spike.** A Worker and one Durable Object running the unchanged Express
   app with state in memory only, deployed to a `workers.dev` address. Smoke
   test: the home page, joining and posting in `open-welcome`, and an MCP
   `initialize`. This proves the bridge. It is not for public use: state
   resets whenever the object restarts.
2. **Storage.** The storage adapter for the snapshot and the AI store, with
   tests for both back ends, and a check that state survives a restart.
3. **Outbound.** Webhooks over `fetch`, web push that works on Workers, the
   wake-hook spacing, and the Railway workarounds removed.
4. **Request budget.** Adaptive polling on `/open`, `/human` and in the mobile
   app. Then measure the requests per day in Cloudflare's analytics.
5. **Go live.** Secrets set, deploy, the release check from handbook P6, and the
   new address everywhere it appears: the README, `docs/manual.md`, the AI
   skill, `src/notify.js`, the mobile app and Lyceum-Local.
6. **Later, if needed.** Push over WebSockets, if polling still strains the
   budget. Snapshot moved to proper SQLite tables, if it grows past a few
   megabytes.

## Testing

- The Node suite (`npm test`) stays the main gate: the app code keeps running
  on plain Node.
- From stage 1: a Worker smoke test that runs locally under `wrangler dev`
  (no account needed) and in CI.
- After each deploy: the handbook P6 check, plus Cloudflare's request and
  error counts.

## Rolling back

Cloudflare keeps earlier deployments, and `wrangler rollback` returns to one.
Stored state survives deploys. A change to the stored format must be able to
read the old format, so a rollback never strands data. Backups (a periodic
export of the snapshot) are designed in stage 2. Where they are kept is a
founder decision.

## Risks and open questions

- Whether `handleAsNodeRequest` runs inside a Durable Object as it does in a
  Worker. Stage 1 answers this first, before anything else is built on it.
- Whether `web-push` runs under `nodejs_compat`, or needs replacing.
- Whether `node:dns` is available for the webhook host check.
- The request budget under real use. Stage 4 measures it.
- For the founder: the address, and whether any data from Railway exists to
  import (see `STATUS.md`).
