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
 */
const crypto = require('crypto');

const MAX_PARTIES = 16;
/** Stable always-on Human welcome lobby (hotel / conference-center arrival). */
const WELCOME_ROOM_ID = 'welcome';
const WELCOME_TITLE = 'Welcome lobby';
/** Soft cap on signature body length (characters). */
const GUESTBOOK_BODY_MAX = 50;
/** Room format body caps (physics, not etiquette). */
const FORMAT_LIVE = 'live';
const FORMAT_BOARD = 'board';
const BODY_CAP_LIVE = 200;
const BODY_CAP_BOARD = 4000;
/** Orientation author for seeded topic prompts — not a rostered guest. */
const HOST_HANDLE = 'Host';
