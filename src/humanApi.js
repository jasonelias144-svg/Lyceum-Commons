/**
 * Human stream API — /api/human/*
 * H:H only. Refuses party:"ai" and any non-human claim (not_human).
 *
 * Seeded topic shelf: GET /topics lists root topic rooms (excludes welcome).
 * Branch: POST /rooms/:id/branch creates a child with parent_id.
 * Merge: POST /rooms/:id/merge { target_id } moves messages; sets merged_into.
 * Branch/merge require the actor on the parent/source (and merge target) roster.
 * Seeded roots and welcome cannot be merge sources; welcome cannot be a merge target.
 * Join/post/list/leave reuse rooms/:id/*.
 * Room format live|board sets post body caps (200 / 4000); fixed at create/seed.
 *
 * Humans are guests, as in Open (#41; shared logic in guestIdentity.js, Human data in store.js):
 * a keyless join returns a guest_key once, and every call made as that name (post, list as
 * ?handle=, leave, branch, merge) must send it as X-Lyceum-Guest. No key → 401
 * guest_key_required; someone else's key → 403 not_joined. A held or lookalike name → 409
 * handle_taken with one generic message. One key holds at most 5 names; 30 idle days release one.
 * Posts (#46 ladder): charged to the guest key (live 45/min, board 20/min) and to a 120/min
 * address ceiling; a keyless takeHumanPost call still uses the address-only bucket.
 */
const express = require('express');
const store = require('./store');
const rateLimit = require('./rateLimit');
const guestIdentity = require('./guestIdentity');
const { protocolError, sendError } = require('./errors');

const router = express.Router();

const HANDLE_RE = /^[^\x00-\x1f\x7f]{1,40}$/;

function assertHumanParty(party) {
  if (party === undefined || party === null) {
    throw protocolError('invalid_request', 'party must be declared as "human".');
  }
  if (party !== 'human') {
    throw protocolError('not_human');
  }
}

function validateHandle(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || !handle.trim()) {
    throw protocolError('invalid_handle');
  }
  return handle.trim();
}

function validateBody(body, { format } = {}) {
  if (typeof body !== 'string') {
    throw protocolError('invalid_body');
  }
  const trimmed = body.trim();
  const fmt = store.normalizeFormat(format, store.FORMAT_BOARD);
  const max = store.bodyCapForFormat(fmt);
  if (trimmed.length < 1 || body.length > max) {
    const detail =
      fmt === store.FORMAT_LIVE
        ? 'Live rooms take up to 200 characters.'
        : 'Board rooms take up to 4000 characters.';
    throw protocolError('invalid_body', detail);
  }
  return body;
}

/** The Human stream's guest registry, seen through the shared guest-key logic. */
const humanGuests = { resolve: store.resolveGuest };

function guestOf(req) {
  return guestIdentity.guestOf(req, humanGuests);
}

/**
 * Acting as `handle` in `room`: it must be on the roster and the request must carry the Human
 * guest key that holds it. Records the call as activity. Returns the guest id.
 */
/**
 * Acting as `handle` in `room`. `present: true` (default) requires a live seat; `present: false`
 * allows an away member (leave, so a timed-out holder can free their name).
 */
function requireOwnHandle(req, room, handle, { present = true } = {}) {
  const gid = guestIdentity.requireOwnName(req, humanGuests, {
    joined: present ? store.hasHuman(room, handle) : store.isMember(room, handle),
    owns: (g) => store.ownsHuman(room, handle, g),
  });
  if (present) store.touch(room, handle);
  return gid;
}

/** Store identity refusals (handle_taken) carry their own generic detail and no status. */
function sendJoinError(res, err) {
  if (err.code === 'handle_taken' && !err.status) {
    return sendError(res, protocolError(err.code, err.detail));
  }
  return sendError(res, err);
}


/** One Human post, or a 429 with Retry-After. Charged to the guest key (live/board rate) and to
 * the address ceiling once a key exists; keyless calls stay on the address-only bucket (#46). */
function takeHumanPost(req, res, { guestId, format } = {}) {
  const key = guestId ? `human:guest:${guestId}` : null;
  const waitMs = rateLimit.takeHumanPost(rateLimit.clientKey(req), key, { format });
  if (!waitMs) return;
  res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
  throw protocolError('rate_limited');
}

function requireRoom(id) {
  const room = store.getRoom(id);
  if (!room) throw protocolError('room_not_found');
  return room;
}

function roomMeta(room) {
  return {
    room_id: room.id,
    title: room.title || null,
    parent_id: room.parent_id ?? null,
    merged_into: room.merged_into ?? null,
    stream: room.stream,
    participants: room.participants,
    format: store.normalizeFormat(room.format, store.FORMAT_BOARD),
  };
}

function assertNotMerged(room) {
  if (room.merged_into) {
    throw protocolError(
      'room_merged',
      `This room was merged into ${room.merged_into}. Join that room instead.`
    );
  }
}

router.get('/topics', (_req, res) => {
  try {
    res.json({ topics: store.listTopics() });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms', (req, res) => {
  try {
    if (req.body && req.body.party !== undefined && req.body.party !== 'human') {
      throw protocolError('not_human');
    }
    let format = store.FORMAT_BOARD;
    if (req.body && req.body.format !== undefined) {
      if (req.body.format !== store.FORMAT_LIVE && req.body.format !== store.FORMAT_BOARD) {
        throw protocolError('invalid_request', 'format must be "live" or "board".');
      }
      format = req.body.format;
    }
    const room = store.createRoom({ format });
    res.status(201).json({
      ...roomMeta(room),
      created_at: room.created_at,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms/:id/branch', (req, res) => {
  try {
    const parent = requireRoom(req.params.id);
    assertNotMerged(parent);
    const { handle: rawHandle, party, title } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);
    const gid = requireOwnHandle(req, parent, handle);
    const room = store.branchRoom(parent, { title });
    store.seatInBranch(room, handle, gid);
    res.status(201).json({
      ...roomMeta(room),
      created_at: room.created_at,
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms/:id/merge', (req, res) => {
  try {
    const source = requireRoom(req.params.id);
    const { handle: rawHandle, party, target_id: targetId } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);
    if (typeof targetId !== 'string' || !targetId.trim()) {
      throw protocolError('invalid_request', 'target_id is required.');
    }
    const target = requireRoom(targetId.trim());
    assertNotMerged(source);
    store.assertMergeAllowed(source, target);
    requireOwnHandle(req, source, handle);
    requireOwnHandle(req, target, handle);
    const result = store.mergeRooms(source, target);
    res.json({
      ok: true,
      moved: result.moved,
      source: roomMeta(result.source),
      target: roomMeta(result.target),
    });
  } catch (err) {
    if (err.code && !err.status) {
      const mapped = protocolError(err.code);
      return sendError(res, mapped);
    }
    sendError(res, err);
  }
});

router.post('/rooms/:id/join', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    assertNotMerged(room);
    const { handle: rawHandle, party } = req.body || {};
    assertHumanParty(party);
    const handle = validateHandle(rawHandle);
    const { guest_key: guestKey } = store.joinHuman(room, handle, guestOf(req));
    // A key minted here starts on the new-key ramp (#46 ladder, same as Open).
    if (guestKey) rateLimit.markNew(`human:guest:${store.resolveGuest(guestKey)}`);
    res.json({
      ...roomMeta(room),
      // Only on the join that minted it; never again.
      ...(guestKey ? { guest_key: guestKey } : {}),
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendJoinError(res, err);
  }
});

router.post('/rooms/:id/post', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    assertNotMerged(room);
    const { handle: rawHandle, body: rawBody, party } = req.body || {};
    if (party !== undefined && party !== 'human') {
      throw protocolError('not_human');
    }
    const handle = validateHandle(rawHandle);
    const gid = requireOwnHandle(req, room, handle);
    const body = validateBody(rawBody, { format: room.format });
    takeHumanPost(req, res, { guestId: gid, format: room.format });
    const crypto = require('crypto');
    const message = {
      id: `msg_${crypto.randomBytes(6).toString('hex')}`,
      room_id: room.id,
      author: handle,
      party: 'human',
      body,
      created_at: new Date().toISOString(),
    };
    room.messages.push(message);
    res.status(201).json({ message });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/rooms/:id/messages', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const handle = req.query.handle;
    if (handle !== undefined) {
      requireOwnHandle(req, room, String(handle).trim());
    }
    let messages = room.messages;
    const after = req.query.after;
    if (after) {
      const idx = messages.findIndex((m) => m.id === after);
      messages = idx >= 0 ? messages.slice(idx + 1) : messages;
    }
    res.json({
      ...roomMeta(room),
      messages,
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/rooms/:id/leave', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    const { handle: rawHandle, party } = req.body || {};
    if (party !== undefined && party !== 'human') {
      throw protocolError('not_human');
    }
    const handle = validateHandle(rawHandle);
    // Only the guest holding the name can free it (present or away); nobody else learns anything.
    requireOwnHandle(req, room, handle, { present: false });
    store.leaveHuman(room, handle);
    res.json({
      ok: true,
      ...roomMeta(room),
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /rooms/:id/heartbeat
 * X-Lyceum-Guest; { handle, party?: "human" }
 * Keeps a quiet participant on the roster (refreshes last_seen) without reading or posting.
 * Idle past HUMAN_PRESENCE_TTL_MS, a participant drops off the roster and must join again.
 */
router.post('/rooms/:id/heartbeat', (req, res) => {
  try {
    const room = requireRoom(req.params.id);
    assertNotMerged(room);
    const { handle: rawHandle, party } = req.body || {};
    if (party !== undefined && party !== 'human') {
      throw protocolError('not_human');
    }
    const handle = validateHandle(rawHandle);
    requireOwnHandle(req, room, handle);
    res.json({
      ok: true,
      ...roomMeta(room),
      roster: store.listRoster(room),
    });
  } catch (err) {
    sendError(res, err);
  }
});


module.exports = router;
