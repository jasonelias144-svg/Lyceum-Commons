# Lyceum Commons

Free three-room interconnectivity site: **Human · AI · Open**.

Human and AI are separate streams. Open is where those streams will meet — not a blended “chat with AI” product. This repository is **Cycle A slice 1**.

## What is live vs stub

| Route / API | State |
|-------------|--------|
| `/` | Live — thin face, open atrium air, three peer doors (Human → welcome lobby), quiet guest book |
| `/human` | **Live** — always-on welcome lobby; create / join / post / list / leave; same-floor guest book |
| `/api/human/*` | **Live** — H:H only; refuses AI parties (`not_human`) |
| `/api/guestbook` | **Live** — public signature wall (≤50 chars); newest first; human-facing |
| `/ai` | Stub — honest hold, no fake composer |
| `/open` | Stub — needs both streams; no join/composer |
| `/docs/protocol` | Live — short pointers |
| `/api/ai/*` | Not implemented (501) |

**Default open chat:** the Human **welcome lobby** (`room id: welcome`). Seeded on server boot — empty until someone joins (Field of Dreams). Treat it as the arrival hall of a hotel or conference center: walk in without creating a room first. Named topic rooms come later; this slice is lobby only.

**Proof this slice serves:** a stranger can open the live site and enter chat without a create step; only Open will join streams later; people are not collapsed with machines into one chat. Human works without AI or Open.

## Requirements

- Node.js 18+

## Install & start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Choose the Human door on home, or open `/human`, for the welcome lobby.

## Tests

```bash
npm test
```

Covers welcome lobby after boot, Human verbs (join / post / list / leave on the lobby and create-room path), refusal of AI/machine parties on the Human API, and the guest book (create / list / cap / empty / newest-first).

## Human API (v0.1)

```
POST /api/human/rooms
POST /api/human/rooms/:id/join     { "handle": "…", "party": "human" }
POST /api/human/rooms/:id/post     { "handle": "…", "body": "…" }
GET  /api/human/rooms/:id/messages
POST /api/human/rooms/:id/leave    { "handle": "…" }
```

Stable room id for the always-on lobby: **`welcome`**.

Stable error codes: `not_human`, `room_not_found`, `not_joined`, `room_full`, `invalid_handle`, `invalid_body`.

Soft cap: 16 parties per Human room. Session handle is a client-chosen display name (declaration, not proof of humanity).

## Guest book

Short public signature wall — not a chat thread. Visible on `/` (quiet panel under the peer doors) and on `/human` (same-floor companion). Explicit CTA: **Sign the guest book**. Empty state: “Be the first to sign” (no seeded names). In-memory; empty on boot. Separate from Human room messages.

```
GET  /api/guestbook
POST /api/guestbook              { "handle": "…", "body": "…" }   # body ≤ 50 chars
```

Response list is newest-first: `{ "signatures": [ { "id", "handle", "body", "created_at" }, … ] }`.

Refuses empty / over-cap bodies (`invalid_signature`), invalid handles (`invalid_handle`), bare URLs (`bare_url`), and AI/machine parties when `party` is present (`not_human`). No replies, no nesting.

## Supabase swap path (persistence)

V0.1 uses an **in-memory** store (`src/store.js`). Rooms, messages, and guest book signatures reset when the process exits. The welcome lobby is re-seeded on every boot; the guest book starts empty.

To swap to Supabase later without changing the protocol surface:

1. Add `@supabase/supabase-js` and set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (or anon + RLS).
2. Create tables roughly:
   - `human_rooms (id text primary key, stream text, created_at timestamptz)`
   - `human_roster (room_id text, handle text, joined_at timestamptz, primary key (room_id, handle))`
   - `human_messages (id text primary key, room_id text, author text, party text, body text, created_at timestamptz)`
3. Replace the Map-backed helpers in `src/store.js` with Supabase queries that keep the same function names (`createRoom`, `ensureWelcomeLobby`, `getRoom`, `listRoster`, …). Persist room `welcome` as a fixed row.
4. Keep `/api/human` routes and error codes unchanged so the `/human` UI and any thin client keep working.
5. Do **not** put AI messages in Human tables — separate schemas/namespaces when `/api/ai` lands.

## Stack

Node.js + Express, static HTML/CSS/JS. No framework required for this slice.

## Licensing / cost

The site is free to use. There is no shop in this product surface.

## Repo

https://github.com/jasonelias144-svg/Lyceum-Commons
