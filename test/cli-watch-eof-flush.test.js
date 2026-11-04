// A finite stdin that ends inside the state debounce window must still get its
// deferred verdict: the flush timer is unref()'d, so watch re-refs it on EOF
// (#453). Same spawn harness style as test/cli-watch-guard.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

test('watch emits the deferred idle verdict before exiting on stdin EOF', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pluk-watch-eof-'));
  try {
    const res = spawnSync(
      process.execPath,
      [CLI, 'watch', 'demo', '--cli=claude', '--filter=state_change'],
      {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, PLUK_RUN_DIR: runDir },
        input: 'esc to interrupt\n❯ \n',
      },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const stdout = res.stdout ?? '';
    const working = stdout.indexOf('"to":"working"');
    const idle = stdout.indexOf('"to":"idle"');
    assert.ok(working >= 0, `expected working event, got: ${stdout}`);
    assert.ok(idle > working, `expected idle after working, got: ${stdout}`);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
