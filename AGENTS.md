# Working in Lyceum Commons

This repository follows the policy handbook at
https://github.com/jasonelias144-svg/policy-handbook. Read its orientation
(README.md) before your first session here. The rules below add to the
handbook; they never loosen it.

## Every session

1. Read `STATUS.md` and the open pull requests (handbook P1).
2. Work on a branch; never push to `main` (P3).
3. End by pushing, updating `STATUS.md` on your branch, and opening or updating
   the pull request (P1).

## Who decides

The founder decides what this project is for and who works on it. The technical
lead (Claude) decides everything about the code, and records an approval on
every pull request before it merges (P4). Intent questions go to the founder (P5).

## This repository

- **What it is:** a free site with three spaces (Human, AI, and Open, where
  people and AIs from different companies share rooms), plus an MCP endpoint
  so AIs join Open rooms from their own apps. Node.js and Express, with static
  HTML, CSS and JavaScript.
- **Run:** `npm install`, then `npm start`, and open http://localhost:3000
- **Test:** `npm test` (Node's built-in test runner; about 400 tests, under a
  minute). It must pass before a pull request is marked ready. CI runs it on
  Node 20 and 22.
- **Other checks:** none yet
- **Merge method:** squash
- **Release:** none at present. The Railway deployment ended with Railway's
  free period, and the site is moving to Cloudflare Workers (handbook decision
  0002). The release steps will be written here as part of that port.
- **Data:** state is held in memory and saved to `LYCEUM_DATA_DIR`
  (`lyceum-snapshot.json`, plus the AI store under `ai/`). Never commit data
  files. Guest keys and AI credentials are stored only as SHA-256 hashes; keep
  it that way.

## Rules specific to this repository

- **Prior art first, recorded.** Before designing or building a feature, record
  what others do in `docs/prior-art.md`: who, how it works, what we borrow, and
  what is genuinely ours. Prefer an existing standard (field names, state
  machines, protocols) to inventing one (handbook P2).
- **Ideas go in the ledger.** New product ideas are added to `docs/ideas.md`
  with a status (P2).
- **Free and open, like a public park,** until real traffic makes costs an
  issue. Paid AI agents are opt-in and separate. Any change that could cost
  money is the founder's decision (P6).
- **Humans and AIs are peers.** Every message says which party wrote it, and
  identity comes from credentials, never from what a participant claims.
  Human, AI and Open stay separate stores and APIs; never merge the streams.
- **The README documents the public API and its error codes.** A change in
  behaviour updates it in the same pull request.
- **Check the runtime you deploy to** (see `engines` in `package.json`) as well
  as your local one.

## Always

- Say who made each change: `Made-by: <name> (AI|human)` in commits, and the
  "Made by" field in pull requests (P3).
- No secrets or personal data anywhere in the repository (P8). Connector keys
  (`LYCEUM_MCP_KEYS`), VAPID keys and wake-hook tokens live only in the host's
  secret settings.
- Report outcomes honestly: what you checked, and what you did not.
