// Guards the guard: test/tmux-contract.test.js must fail under CI when tmux
// is missing (the install step in .github/workflows/test.yml regressed) and
// must only skip when running locally or when PLUK_TMUX_OPTIONAL=1 opts out.
// Each case runs the contract file in a child with an empty PATH so tmux is
// never found, whatever the host has installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTRACT_FILE = join(process.cwd(), 'test', 'tmux-contract.test.js');
const GUARD_MESSAGE = /tmux-contract: tmux is not installed but CI is set/;

function runContractWithoutTmux(envOverrides) {
  const emptyPath = mkdtempSync(join(tmpdir(), 'pluk-no-tmux-'));
  const env = { ...process.env, PATH: emptyPath, ...envOverrides };
  for (const k of ['CI', 'PLUK_TMUX_OPTIONAL', 'TMUX', 'TMUX_TMPDIR']) {
    if (envOverrides[k] === undefined) delete env[k];
  }
  // node:test refuses to run files from inside another --test process.
  delete env.NODE_TEST_CONTEXT;
  try {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', CONTRACT_FILE], {
      env,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
}

test('tmux-contract fails under CI when tmux is missing', () => {
  const r = runContractWithoutTmux({ CI: 'true' });
  assert.notEqual(r.status, 0, `expected a failing exit, got:\n${r.out}`);
  assert.match(r.out, GUARD_MESSAGE);
  assert.match(r.out, /\.github\/workflows\/test\.yml/);
});

test('tmux-contract skips (not fails) without CI when tmux is missing', () => {
  const r = runContractWithoutTmux({});
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, GUARD_MESSAGE);
  assert.match(r.out, /# skipped [1-9]\d*/);
  assert.match(r.out, /# fail 0/);
});

test('PLUK_TMUX_OPTIONAL=1 restores the skip under CI', () => {
  const r = runContractWithoutTmux({ CI: 'true', PLUK_TMUX_OPTIONAL: '1' });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, GUARD_MESSAGE);
  assert.match(r.out, /# skipped [1-9]\d*/);
});
