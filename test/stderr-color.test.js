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

// --- stdout (#326) ---

import { paintStdout, stdoutColorEnabled, ANSI_GREEN } from '../dist/ansi.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function runPluk(args, noColor) {
  const env = { ...process.env, NO_COLOR: noColor };
  delete env.PLUK_RUN_DIR;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('--help, sessions and patterns emit no ESC bytes on stdout under NO_COLOR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-color-'));
  try {
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const ev = (type, data) => JSON.stringify({ v: 1, ts: '2026-01-01T00:00:00.000Z', seq: 0, pid: 1, session: 's', pane: 'p', source: 't', type, data });
    writeFileSync(join(dir, 'logs', 'a.jsonl'), [ev('raw_output', { cli: 'claude' }), ev('state_change', { to: 'working' })].join('\n') + '\n');
    for (const noColor of ['1', '']) {
      for (const args of [['--help'], ['sessions', `--run-dir=${dir}`], ['sessions', `--run-dir=${join(dir, 'none')}`], ['patterns'], ['patterns', '--cli=no-such-cli']]) {
        const r = runPluk(args, noColor);
        assert.equal(r.status, 0);
        assert.ok(r.stdout.length > 0);
        assert.ok(!r.stdout.includes('\x1b'), `${args.join(' ')}: ${JSON.stringify(r.stdout)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paintStdout colours only on a TTY without NO_COLOR', () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const prev = process.env.NO_COLOR;
  try {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    assert.equal(stdoutColorEnabled(), true);
    assert.equal(paintStdout(ANSI_GREEN, 'x'), `${ANSI_GREEN}x\x1b[0m`);
    process.env.NO_COLOR = '1';
    assert.equal(paintStdout(ANSI_GREEN, 'x'), 'x');
    delete process.env.NO_COLOR;
    process.stdout.isTTY = false;
    assert.equal(stdoutColorEnabled(), false);
    assert.equal(paintStdout(ANSI_GREEN, 'x'), 'x');
  } finally {
    if (desc) Object.defineProperty(process.stdout, 'isTTY', desc); else delete process.stdout.isTTY;
    if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;
  }
});
