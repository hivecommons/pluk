import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from '../dist/watch.js';

// Guards the production default: watch.ts calls tmuxCapturePane(target) with
// no timeout override, so a hung tmux server only fails to freeze the watcher
// if the default bound in tmux.ts stays in place. tmux-capture-timeout.test.js
// passes an explicit 50 ms, which would stay green if that default were ever
// dropped. This test uses the real default, so it waits for it to fire; it
// also caps the wait so a missing default fails instead of hanging forever.
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
// Longer than the default bound but shorter than the fake tmux's hang, so a
// dropped default surfaces as the hang itself returning, not as a timeout.
const MAX_RELEASE_MS = DEFAULT_QUERY_TIMEOUT_MS + 2000;
const HARD_CAP_MS = 20000;

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('capture mode counts a hung tmux server as a capture failure and keeps the watcher alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-hung-tmux-watch-'));
  const savedPath = process.env.PATH;
  const events = [];
  let handle;
  try {
    // Hang only on the first call: once the bound releases that poll, the
    // overdue interval fires again immediately, and a second 5 s block would
    // just double the test's wall time without proving anything more.
    const marker = join(dir, 'first-call-done');
    writeFileSync(
      join(dir, 'tmux'),
      `#!/bin/sh\nif [ -e "${marker}" ]; then exit 1; fi\ntouch "${marker}"\nexec sleep 10\n`,
    );
    chmodSync(join(dir, 'tmux'), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;

    handle = watch({
      session: 'hung-tmux-session',
      cli: 'claude',
      mode: 'capture',
      captureIntervalMs: 20,
      onEvent: (e) => events.push(e),
    });

    const started = Date.now();
    while (handle.stats().captureFailures === 0 && Date.now() - started < HARD_CAP_MS) {
      await settle(100);
    }
    const elapsed = Date.now() - started;
    const stats = handle.stats();

    assert.ok(stats.captureFailures >= 1, `expected a capture failure within ${HARD_CAP_MS}ms, got stats ${JSON.stringify(stats)}`);
    assert.ok(stats.framesPolled >= stats.captureFailures, 'every failure is a polled frame');
    // The poll must have been released by the default bound, not by anything shorter.
    assert.ok(elapsed >= DEFAULT_QUERY_TIMEOUT_MS - 500, `poll returned after ${elapsed}ms, earlier than the default bound`);
    assert.ok(elapsed < MAX_RELEASE_MS, `poll took ${elapsed}ms: the default bound did not fire`);
    assert.deepEqual(events, []);
  } finally {
    handle?.stop();
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
