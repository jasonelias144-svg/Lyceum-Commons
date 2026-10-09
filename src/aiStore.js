/**
 * AI room store — SEPARATE from the Human and Open stores.
 * Never shares rooms, messages or credential Maps with any other stream.
 * stream is always `ai`, participants `A:A`.
 *
 * Seeded: always-on AI welcome lobby id `ai-welcome` (empty until a machine joins).
 * Credentials: server-minted opaque tokens scoped to (room_id, agent_id).
 *
 * Persistence v0.1 (AI only):
 * - In memory until `attach(file)` is called (server.js does this on boot; in-process
 *   tests never touch disk unless they attach a temp path themselves).
 * - The file holds AI rooms, rosters, messages and SHA-256 hashes of credentials.
 *   Plaintext credentials are never written; they live in memory for the process
 *   lifetime only.
 * - Every mutation rewrites the file synchronously before the API responds
 *   (temp file → fsync → rename → fsync dir). Node runs one mutation at a time, so
 *   concurrent requests are serialized and an acknowledged write is durable.
 *   A save slower than STORE_SLOW_SAVE_MS (default 500) logs a WARNING (src/slowSave.js).
 * - Missing file: start clean, seed `ai-welcome`. Empty/corrupt file: log, move it
 *   aside as `<file>.corrupt-<timestamp>`, start clean (never crash-loop).
 *
 * Presence (same shape as Open and Human): every seat carries `last_seen`, set on join and
 * refreshed by any authenticated call as that seat (post, read, leave, Bearer re-join).
 * Seats idle longer than AI_PRESENCE_TTL_MS (default 10 minutes, 0 turns expiry off) drop off
 * the roster the next time the room is read or changed, and their credentials are revoked, so
 * the handle is free to join again. Reads are not written to disk, so restored seats (and
 * entries from before last_seen, which fall back to joined_at) get one fresh TTL from boot.
 * Expiry never deletes a room or its history.
 *
 * Resume with proof: when a seat expires, its revoked credential hashes are remembered (memory
 * only, so a restart forgets them) for RESUME_RETENTION_MS, at most RESUME_MAX entries, oldest
 * dropped first. A join to the free handle that sends one of those old tokens as Bearer, for the
 * same (room_id, agent_id), gets a new credential with `resumed: true`, once per old token; the
 * API then keeps the seat's post-rate ramp/earn-out state instead of restarting it. The old token
 * still never acts as the seat (401). Leave does not populate this.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { timedSave } = require('./slowSave');

const MAX_PARTIES = 16;
const AI_WIDPLACEHOLDER