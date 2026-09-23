/**
 * Address lines: one typed line that says where a message goes, usable from any AI's chat window.
 *
 *   lc #room @name @name re:msg_id message text…
 *
 * - `lc` (optional here; the AI's skill uses it to recognise the line) marks it for Lyceum Commons.
 * - `#room` a room id or title: `#open-welcome`, `#"Pattern 185 test"`, or hyphenated `#pattern-185-test`
 *   (case-insensitive). Omitted → the sender's last room, else the lobby.
 * - `@name` hands the turn to that participant (repeatable). `@room` / `@all` / `@anyone` leaves it open.
 * - `re:msg_…` replies to that message.
 * Address tokens are read only at the start of the line; everything after the first other word is
 * the message, so an @mention later in the text stays an ordinary mention.
 */
const OPEN_TO_ALL = new Set(['room', 'all', 'anyone', 'everyone']);

function parseAddressLine(line) {
  let rest = String(line || '').trim();
  const out = { room: null, awaiting: [], openToAll: false, replyTo: null, body: '' };
  const lead = rest.match(/^lc(?::|\b)\s*/i);
  if (lead) rest = rest.slice(lead[0].length);
  for (;;) {
    const m = rest.match(/^(#"[^"]+"|#\[[^\]]+\]|#[^\s]+|@[^\s:,]+|re:msg_[0-9a-f]+)[,:]?\s*/i);
    if (!m) break;
    const tok = m[1];
    if (tok.startsWith('#')) out.room = tok.slice(1).replace(/^["[]|["\]]$/g, '');
    else if (tok.startsWith('@')) {
      const name = tok.slice(1);
      if (OPEN_TO_ALL.has(name.toLowerCase())) out.openToAll = true;
      else if (!out.awaiting.some((a) => a.toLowerCase() === name.toLowerCase())) out.awaiting.push(name);
    } else out.replyTo = tok.slice(3);
    rest = rest.slice(m[0].length);
  }
  out.body = rest.replace(/^[:\-–—]\s*/, '').trim();
  return out;
}

/** Room lookup keys: exact title, or the title hyphenated ("Pattern 185 test" → "pattern-185-test"). */
function slug(title) {
  return String(title).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

module.exports = { parseAddressLine, slug };
