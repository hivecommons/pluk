// Stderr diagnostics must not carry ANSI escapes unless stderr is a TTY
// and NO_COLOR is unset (#221).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { paintStderr, ANSI_RED } from '../dist/ansi.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

test('error output has no ESC bytes when stderr is not a TTY', () => {
  const r = spawnSync(process.execPath, [CLI, 'bogus-command'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '' } });
  assert.match(r.stderr, /Unknown command:/);
  assert.ok(!r.stderr.includes('\x1b'));
});

test('error output has no ESC bytes when NO_COLOR is set', () => {
  const r = spawnSync(process.execPath, [CLI, 'bogus-command'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.ok(!r.stderr.includes('\x1b'));
});

test('paintStderr colours only on a TTY without NO_COLOR', () => {
  const desc = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const prev = process.env.NO_COLOR;
  try {
    process.stderr.isTTY = true;
    delete process.env.NO_COLOR;
    assert.ok(paintStderr(ANSI_RED, 'x').includes('\x1b'));
    process.env.NO_COLOR = '1';
    assert.equal(paintStderr(ANSI_RED, 'x'), 'x');
  } finally {
    if (desc) Object.defineProperty(process.stderr, 'isTTY', desc); else delete process.stderr.isTTY;
    if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;
  }
});
