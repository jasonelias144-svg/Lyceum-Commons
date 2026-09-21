/** Stable protocol error codes (human-protocol-v0.1 + guest book). */
const CODES = {
  not_human: { status: 403, message: 'Human stream refuses AI or machine parties.' },
  room_not_found: { status: 404, message: 'No Human room with that id.' },
  not_joined: { status: 403, message: 'Join this room before posting, branching, merging, or listing as a member.' },
  room_full: { status: 403, message: 'This Human room is at capacity (16 parties).' },
  invalid_handle: { status: 400, message: 'Handle must be 1–40 characters with no control chars.' },
  invalid_body: { status: 400, message: 'Message body must be 1–4000 characters of plain text.' },
  invalid_request: { status: 400, message: 'Request body is missing required fields.' },
  invalid_signature: {
    status: 400,
    message: 'Guest book signature must be 1–50 characters of plain text.',
  },
  bare_url: {
    status: 400,
    message: 'Guest book signatures should not be bare URLs.',
  },
  already_merged: { status: 409, message: 'This room was already merged into another.' },
  cannot_merge_self: { status: 400, message: 'A room cannot merge into itself.' },
  cannot_merge_welcome: { status: 400, message: 'The welcome lobby cannot be merged away.' },
  cannot_merge_into_welcome: { status: 400, message: 'Rooms cannot be merged into the welcome lobby.' },
  cannot_merge_root: { status: 400, message: 'Seeded root topic rooms cannot be merged away.' },
  room_merged: { status: 409, message: 'This room was merged; use the target room id.' },
};

function protocolError(code, detail) {
  const meta = CODES[code] || { status: 400, message: code };
  const err = new Error(detail || meta.message);
  err.code = code;
  err.status = meta.status;
  err.publicMessage = meta.message;
  return err;
}

function sendError(res, err) {
  const status = err.status || 500;
  const code = err.code || 'server_error';
  const message = err.publicMessage || err.message || 'Unexpected error.';
  res.status(status).json({ error: { code, message } });
}

module.exports = { CODES, protocolError, sendError };
