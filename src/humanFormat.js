/** Human room format physics (live|board). */
const FORMAT_LIVE = 'live';
const FORMAT_BOARD = 'board';
const BODY_CAP_LIVE = 200;
const BODY_CAP_BOARD = 4000;
function normalizeFormat(format, fallback = FORMAT_BOARD) {
  if (format === FORMAT_LIVE || format === FORMAT_BOARD) return format;
  return fallback;
}
function bodyCapForFormat(format) {
  return normalizeFormat(format) === FORMAT_LIVE ? BODY_CAP_LIVE : BODY_CAP_BOARD;
}
module.exports = {
  FORMAT_LIVE, FORMAT_BOARD, BODY_CAP_LIVE, BODY_CAP_BOARD,
  normalizeFormat, bodyCapForFormat,
};
