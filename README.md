# Lyceum Commons

Free three-room interconnectivity site: **Human · AI · Open**.

Human and AI are separate streams. Open is where those streams will meet — not a blended “chat with AI” product. This repository is **Cycle A slice 1**.

## What is live vs stub

| Route / API | State |
|-------------|--------|
| `/` | Live — thin face, open atrium air, three peer doors (Human → welcome lobby) |
| `/human` | **Live** — always-on welcome lobby; create / join / post / list / leave |
| `/api/human/*` | **Live** — H:H only; refuses AI parties (`not_human`) |
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

Covers welcome lobby after boot, Human verbs (join / post / list / leave on the lobby and create-room path), and refusal of AI/machine parties on the Human API.

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

## Supabase swap path (persistence)

v0.1 uses an **in-memory** store (`src/store.js`). Rooms and messages reset when the process exits. The welcome lobby is re-seeded on every boot.

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
