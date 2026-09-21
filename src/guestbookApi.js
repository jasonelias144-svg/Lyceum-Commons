/**
 * Guest book API — /api/guestbook
 * Short public signature wall. Separate from Human room messages.
 * Human-facing only: refuses party:"ai" / machine when party is present.
 */
const express = require('express');
const store = require('./store');
const { protocolError, sendError } = require('./errors');

const router = express.Router();

const HANDLE_RE = /^[^\x00-\x1f\x7f]{1,40}$/;
/** Soft refuse bare URLs (http(s)://… or www.… as the whole signature). */
const BARE_URL_RE = /^(https?:\/\/\S+|www\.\S+)$/i;

function validateHandle(handle) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || !handle.trim()) {
    throw protocolError('invalid_handle');
  }
  return handle.trim();
}

function validateSignatureBody(body) {
  if (typeof body !== 'string') {
    throw protocolError('invalid_signature');
  }
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > store.GUESTBOOK_BODY_MAX) {
    throw protocolError('invalid_signature');
  }
  if (BARE_URL_RE.test(trimmed)) {
    throw protocolError('bare_url');
  }
  return trimmed;
}

function assertHumanFacing(party) {
  if (party === undefined || party === null) return;
  if (party !== 'human') {
    throw protocolError('not_human');
  }
}

/** GET /api/guestbook — list signatures, newest first */
router.get('/', (_req, res) => {
  try {
    res.json({ signatures: store.listGuestbook() });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/guestbook — { handle, body } */
router.post('/', (req, res) => {
  try {
    const { handle: rawHandle, body: rawBody, party } = req.body || {};
    assertHumanFacing(party);
    const handle = validateHandle(rawHandle);
    const body = validateSignatureBody(rawBody);
    const signature = store.addGuestbookSignature({ handle, body });
    res.status(201).json({ signature });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
