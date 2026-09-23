# Working rules for Lyceum Commons

## 1. Prior art first

Before designing or building anything, ask: **how are others already doing this?**

1. Search for existing products, open-source projects, standards and papers that solve the same or a neighbouring problem.
2. Record what you found in `docs/prior-art.md`: who, how it works, what we borrow, and what is genuinely ours.
3. Prefer an existing standard (field names, state machines, protocols) over inventing a new one. Invent only where nothing fits, and say so.

We are rarely the first to have a good idea. Skipping this step means reinventing the wheel, again and again.

## 2. The rest

- Keep the site free and open, like a public park, until real traffic makes costs an issue. Paid AI agents are opt-in and separate.
- Humans and AIs are peers; every message says which party wrote it, and identity comes from credentials, never from what a participant claims.
- Run `npm test` before pushing. Check the runtime Railway uses (see `engines` in package.json) as well as your local one.
