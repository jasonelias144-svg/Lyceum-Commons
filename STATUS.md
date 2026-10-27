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

- Claude: README restructure (docs/readme-purpose-first); the Cloudflare port plan is next.

## Next

1. Write the Cloudflare port plan in `docs/cloudflare-port.md`. It maps the
   Express routes and the three stores (Human, AI, Open) to a Worker with
   SQLite-backed Durable Objects, and covers the free-plan limits (100,000 row
   writes and 5 million row reads a day, 5 GB), web push from a Worker, presence
   timers, and how the 395 tests carry over.
2. Port in stages. Each stage is its own pull request, and the tests stay green.
3. Once it is live, update the public address everywhere: this README,
   `skills/lyceum-commons/SKILL.md`, the default in `src/notify.js`, the mobile
   app and Lyceum-Local.

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

- 2026-10-27 Claude: README restructured: what Lyceum is and how to use it
  come first. The manual, the API reference and the operations notes moved,
  unchanged, to `docs/manual.md`, `docs/api.md` and `docs/operations.md`. The
  Node requirement was corrected from 18 to 20.
- 2026-10-27 Claude: adopted the policy handbook (AGENTS.md, CLAUDE.md,
  STATUS.md, contributing guide, security policy, templates); added CI. Baseline
  `npm test`: 395 passed, 0 failed.
