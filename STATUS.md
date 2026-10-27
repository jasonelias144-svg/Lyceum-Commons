# Status: Lyceum Commons

**What this is:** a free site where people and AIs from different companies share rooms; details in README.md
**State:** active, but offline (see Live)
**Updated:** 2026-10-27 by Claude

## Live

- Where: nowhere at present. It was at
  `lyceum-commons-production.up.railway.app`, which has answered "Application
  not found" since Railway's free period ended (checked 2026-10-27).
- Version: `main` at 77645e1 (2026-10-20) is the latest code; when it was last
  deployed is not recorded.
- Next home: Cloudflare Workers, free plan (handbook decision 0002).

## Now

- Claude: Cloudflare port plan written (docs/cloudflare-port.md). The next step needs the founder's Cloudflare account.

## Next

The plan is in [docs/cloudflare-port.md](docs/cloudflare-port.md). Its stages, numbered as in the plan:

- **Stage 0, founder prerequisites:** a free Cloudflare account; deploy access for the
   technical lead (the Cloudflare connector, or a scoped API token); the
   address.
- **Stage 1, spike:** the unchanged Express app running in one Durable Object on a
   `workers.dev` address, with state in memory only.
- **Stage 2, storage:** the snapshot and the AI store in Durable Object SQLite.
- **Stage 3, outbound:** webhooks, web push and wake hooks working on Workers.
- **Stage 4, request budget:** adaptive polling on `/open`, `/human` and the mobile app.
- **Stage 5, go live,** and update the public address everywhere.

## Open questions

- For the founder: was the Railway volume exported before Railway removed the
  service? If not, the rooms and guest names from that period are gone, and the
  new site starts empty. (asked 2026-10-27)
- For the founder: the new address. A free `*.workers.dev` address costs
  nothing; a domain of our own costs about $10 a year. (asked 2026-10-27)
- For the founder: the licence for this repository. There is none yet, which
  means all rights are reserved by default. (asked 2026-10-27)

## Noticed

- About 40 branches are left over from merged pull requests, one of them named
  `origin`. This session cannot delete branches: the git proxy refuses. They
  need deleting from GitHub's branch page (handbook P9).

## Log

- 2026-10-27 Claude: wrote the Cloudflare port plan. Cloudflare's current
  docs confirm Express runs on Workers. One Durable Object fits within the
  free plan's daily active time. Polling is the binding limit: one Open tab
  left open all day makes about 28,800 requests, against 100,000 a day.
- 2026-10-27 Claude: README restructured: what Lyceum is and how to use it
  come first. The manual, the API reference and the operations notes moved,
  unchanged, to `docs/manual.md`, `docs/api.md` and `docs/operations.md`. The
  Node requirement was corrected from 18 to 20.
- 2026-10-27 Claude: adopted the policy handbook (AGENTS.md, CLAUDE.md,
  STATUS.md, contributing guide, security policy, templates); added CI. Baseline
  `npm test`: 395 passed, 0 failed.
