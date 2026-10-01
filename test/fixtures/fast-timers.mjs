// Test-only preload for CLI subprocesses: `node --import ./test/fixtures/fast-timers.mjs dist/cli.js ...`.
//
// Clamps every setTimeout/setInterval delay longer than CLAMP_MS down to
// CLAMP_MS, and advances Date.now() by the skipped amount when the timer
// fires. Code that waits on wall-clock deadlines (the Subscriber's 60 s
// file-wait timeout) or long periodic timers (watch's 30 s log-rotation
// check) therefore runs its real logic in milliseconds, with no test seam
// in the production source. Only Date.now() is skewed: `new Date()` and
// event timestamps keep the real clock.
const CLAMP_MS = Number(process.env['PLUK_TEST_TIMER_CLAMP_MS']) || 20;

let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;

function clamp(orig) {
  return function clampedTimer(fn, delay, ...args) {
    const requested = Number(delay) || 0;
    if (requested <= CLAMP_MS) return orig(fn, requested, ...args);
    const skipped = requested - CLAMP_MS;
    return orig(
      (...callArgs) => {
        skew += skipped;
        return fn(...callArgs);
      },
      CLAMP_MS,
      ...args,
    );
  };
}

globalThis.setTimeout = clamp(globalThis.setTimeout);
globalThis.setInterval = clamp(globalThis.setInterval);
