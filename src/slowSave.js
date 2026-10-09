/**
 * Slow-save warning for the synchronous store writes.
 *
 * Saves block the event loop: the AI store rewrites its file (temp → fsync → rename → fsync dir)
 * before the API answers, and the shared snapshot (persist.js) is written in one go. A stalled
 * disk therefore shows up as a hung request with nothing in the log. Each save is timed, and one
 * that takes longer than STORE_SLOW_SAVE_MS (default 500; whole numbers only, 0 turns the
 * warning off, anything else falls back to the default with one WARNING) logs one WARNING line.
 * Timing only: a save behaves exactly as before, including when it throws.
 */
const DEFAULT_SLOW_SAVE_MS = 500;

/** Injectable clock (tests replace it so nothing has to be slow). */
let clock = () => Date.now();

/** Replace the clock; call with no argument to restore Date.now. */
function _setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

const thresholdCache = { raw: undefined, value: DEFAULT_SLOW_SAVE_MS };

/** Threshold in ms (STORE_SLOW_SAVE_MS); 0 means the warning is off. */
function slowSaveThresholdMs() {
  const raw = process.env.STORE_SLOW_SAVE_MS;
  if (raw === thresholdCache.raw) return thresholdCache.value;
  let value = DEFAULT_SLOW_SAVE_MS;
  if (raw !== undefined && raw !== '') {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      console.warn(`[store] WARNING: STORE_SLOW_SAVE_MS=${JSON.stringify(raw)} is not a whole number of ms; using the default ${DEFAULT_SLOW_SAVE_MS}.`);
    } else {
      value = Number(raw);
    }
  }
  thresholdCache.raw = raw;
  thresholdCache.value = value;
  return value;
}

/** Run `save()` (which writes `file`), warn if it was slow, and return what it returned. */
function timedSave(file, save) {
  const start = clock();
  try {
    return save();
  } finally {
    const ms = clock() - start;
    const threshold = slowSaveThresholdMs();
    if (threshold && ms > threshold) {
      console.warn(`[store] WARNING: slow save of ${file} took ${ms} ms (threshold ${threshold} ms)`);
    }
  }
}

module.exports = {
  DEFAULT_SLOW_SAVE_MS,
  slowSaveThresholdMs,
  timedSave,
  _setClock,
};
