// A finite stdin that ends inside the state debounce window must still get its
// deferred verdict: the flush timer is unref()'d, so watch re-refs it on EOF
// (#453). Same spawn harness style as test/cli-watch-fault-injection.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function collector(stream, label, timeoutMs = 10000) {
  let buf = '';
  const waiters = [];
  stream.on('data', d => {
    buf += d;
    for (const w of waiters.splice(0)) {
      if (!w.check()) waiters.push(w);
    }
  });
  return {
    get text() {
      return buf;
    },
    waitFor(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label}: condition not met within ${timeoutMs}ms; got: ${buf}`)),
          timeoutMs,
        );
        const check = () => {
          if (predicate(buf)) {
            clearTimeout(timer);
            resolve(buf);
            return true;
          }
          return false;
        };
        if (!check()) waiters.push({ check });
      });
    },
  };
}

test('watch emits the deferred idle verdict before exiting on stdin EOF', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pluk-watch-eof-'));
  try {
    const child = spawn(
      process.execPath,
      [CLI, 'watch', 'demo', '--cli=claude', '--filter=state_change'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PLUK_RUN_DIR: runDir } },
    );
    const out = collector(child.stdout, 'stdout');
    const err = collector(child.stderr, 'stderr');
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));

    child.stdin.write('esc to interrupt\n');
    await out.waitFor(s => s.includes('"to":"working"'));

    // The classifier clock has one-second resolution and idle evidence only
    // wins once it is strictly newer than the working evidence, so the
    // end-of-turn repaint must land in a later second. It is still inside the
    // debounce window, so the idle verdict is deferred to the flush timer.
    await sleep(1100);
    child.stdin.write('❯ \n');
    child.stdin.end();

    const { code, signal } = await exited;
    assert.equal(signal, null, `must not die from a signal (stderr: ${err.text})`);
    assert.equal(code, 0, `stderr: ${err.text}`);
    const working = out.text.indexOf('"to":"working"');
    const idle = out.text.indexOf('"to":"idle"');
    assert.ok(working >= 0, `expected working event, got: ${out.text}`);
    assert.ok(idle > working, `expected idle after working, got: ${out.text}`);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
