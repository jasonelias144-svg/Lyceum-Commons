/**
 * In-memory Human room store (v0.1) + guest book signatures.
 * Swap path: replace this module with a Supabase-backed store that
 * implements the same createRoom / join / post / list / leave / branch / merge surface.
 * See README "Supabase swap path".
 *
 * Guest book is separate from Human room messages — a signature wall, not a thread.
 *
 * Seeded rooms: welcome lobby (empty) + ~12 root topic rooms with one Host
 * orientation each (Field of Dreams). Rooms may branch via parent_id.
 * No fake guests, no fabricated back-and-forth.
 * Room format: welcome → live (200); topic roots + private create → board (4000);
 * branches inherit parent format. Cycle A: fixed at create/seed.
 *
 * Guest identity (same rules as Open, logic shared through guestIdentity.js, data kept here and
 * nowhere else). Membership (room.members: { owner, last_active }) is separate from presence
 * (room.roster): seats idle past HUMAN_PRESENCE_TTL_MS (default 10 minutes, matching Open) drop
 * off the roster and free a capacity slot, while the key keeps the name for 30 days. Human guest
 * keys live in this store's own registry. Unclaimed seats from before guest keys count as away
 * at once on restore; owned seats get one fresh presence TTL from boot (same as Open), then
 * drop off the roster so a restart never keeps stale seats occupied forever.
 */
