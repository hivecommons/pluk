// Covers the cmdWatch rotation-skip guard and the run-tests.mjs main() entry
// path, which test/cli.test.js and test/run-tests-runner.test.js leave
// unexercised: a session name that fails validateSessionName must skip log
// rotation (never derive a log path from it) while classification keeps
// working, and the npm-test runner must propagate the child suite's exit
// status and refuse an empty test directory. Same spawn harness style as
// test/cli.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const RUNNER = join(process.cwd(), 'scripts', 'run-tests.mjs');

function run(argv0, args, opts = {}) {
  const res = spawnSync(process.execPath, [argv0, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
    ...opts,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// --- watch: unsafe session name skips rotation, keeps classifying ------------------

test('watch with a traversal session name skips rotation but still emits events', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pluk-watch-guard-'));
  try {
    const { code, stdout } = run(
      CLI,
      ['watch', '../evil', '--cli=claude', '--include-raw', `--run-dir=${runDir}`],
      { input: 'esc to interrupt\n' },
    );
    // The guard must swallow the unsafe name instead of crashing watch.
    assert.equal(code, 0);
    const events = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(events.length >= 1, `expected events, got: ${stdout}`);
    assert.ok(events.every(ev => ev.session === '../evil'));
    // No log path may be derived from the unsafe name: neither inside the
    // run dir nor traversed out beside it.
    assert.deepEqual(readdirSync(runDir), [], 'no log path derived inside the run dir');
    assert.ok(
      !readdirSync(join(runDir, '..')).includes('evil.jsonl'),
      'no traversed log file beside the run dir',
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// --- run-tests.mjs main(): empty dir refusal and exit-status propagation -----------

test('run-tests.mjs exits 1 with a message when the test dir has no test files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pluk-runner-empty-'));
  try {
    mkdirSync(join(cwd, 'test'));
    const { code, stderr } = run(RUNNER, [], { cwd });
    assert.equal(code, 1);
    assert.match(stderr, /no test\/\*\.test\.js files found/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run-tests.mjs propagates the child suite exit status', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pluk-runner-fail-'));
  try {
    mkdirSync(join(cwd, 'test'));
    writeFileSync(
      join(cwd, 'test', 'boom.test.js'),
      "const { test } = require('node:test');\n" +
        "const assert = require('node:assert');\n" +
        "test('always fails', () => { assert.fail('boom'); });\n",
    );
    // Strip the outer test-runner's NODE_TEST_* / NODE_OPTIONS context so the
    // nested `node --test` run behaves like a top-level `npm test`.
    const { code } = run(RUNNER, [], { cwd, env: { PATH: process.env.PATH } });
    assert.notEqual(code, 0, 'failing child suite must fail the runner');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
