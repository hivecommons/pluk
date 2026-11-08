import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COVERAGE_FLAGS,
  NO_COVERAGE_FLAG,
  coverageArgs,
  listTestFiles,
  buildArgv,
  parseArgs,
} from '../scripts/run-tests.mjs';

test('coverageArgs adds threshold flags only on Node >= 22', () => {
  assert.deepEqual(coverageArgs(20), []);
  assert.deepEqual(coverageArgs(21), []);
  assert.deepEqual(coverageArgs(22), COVERAGE_FLAGS);
  assert.deepEqual(coverageArgs(26), COVERAGE_FLAGS);
});

test('coverageArgs returns a copy, not the shared flag array', () => {
  const args = coverageArgs(22);
  args.push('tampered');
  assert.equal(COVERAGE_FLAGS.includes('tampered'), false);
});

test('COVERAGE_FLAGS enforce the documented 99/96/98 thresholds over non-test files only', () => {
  assert.deepEqual(COVERAGE_FLAGS, [
    '--experimental-test-coverage',
    '--test-coverage-exclude=test/**',
    '--test-coverage-lines=99',
    '--test-coverage-branches=96',
    '--test-coverage-functions=98',
  ]);
});

test('CONTRIBUTING.md documents the thresholds COVERAGE_FLAGS actually enforce', () => {
  // The numbers contributors read must be the numbers CI gates on, or a
  // ratchet in one place silently leaves the other stale.
  const doc = readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf-8');
  const pct = (name) => COVERAGE_FLAGS.find((f) => f.startsWith(`--test-coverage-${name}=`)).split('=')[1];
  assert.match(doc, new RegExp(`lines ${pct('lines')}, branches ${pct('branches')}, functions ${pct('functions')}`));
});

test('test:coverage delegates to the shared runner without inline coverage flags', () => {
  const { scripts } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
  assert.equal(scripts['test:coverage'], 'npm run build && node scripts/run-tests.mjs');
  assert.doesNotMatch(scripts['test:coverage'], /--(?:experimental-test-coverage|test-coverage-)/);
});

test('listTestFiles returns only sorted *.test.js entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-run-tests-'));
  try {
    for (const f of ['b.test.js', 'a.test.js', 'helper.js', 'notes.md']) {
      writeFileSync(join(dir, f), '');
    }
    assert.deepEqual(listTestFiles(dir), [
      `${dir}/a.test.js`,
      `${dir}/b.test.js`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildArgv is a plain --test run on Node 20 and gated on Node 22', () => {
  const files = ['test/a.test.js', 'test/b.test.js'];
  assert.deepEqual(buildArgv(20, files), ['--test', ...files]);
  assert.deepEqual(buildArgv(22, files), [
    '--test',
    ...COVERAGE_FLAGS,
    ...files,
  ]);
});

test('--no-coverage drops the threshold gate on every Node major', () => {
  assert.deepEqual(parseArgs([]), { coverage: true });
  assert.deepEqual(parseArgs([NO_COVERAGE_FLAG]), { coverage: false });
  assert.deepEqual(coverageArgs(22, { coverage: false }), []);
  assert.deepEqual(coverageArgs(26, { coverage: false }), []);
  assert.deepEqual(buildArgv(26, ['test/a.test.js'], { coverage: false }), ['--test', 'test/a.test.js']);
});

test('stryker commandRunner disables the coverage gate so only assertions kill mutants', () => {
  const { commandRunner, checkers } = JSON.parse(readFileSync(join(process.cwd(), 'stryker.config.json'), 'utf-8'));
  assert.match(commandRunner.command, /node scripts\/run-tests\.mjs --no-coverage$/);
  assert.deepEqual(checkers, ['typescript']);
});

// Stryker instruments src/ in its sandbox, so a test that regex-parses source
// text fails the dry run and the whole mutation run reports nothing. The
// command marks itself with PLUK_UNDER_STRYKER=1 and those tests skip on it.
test('stryker commandRunner marks the run so source-text guards can skip', () => {
  const { commandRunner } = JSON.parse(readFileSync(join(process.cwd(), 'stryker.config.json'), 'utf-8'));
  assert.match(commandRunner.command, /(^|&& )PLUK_UNDER_STRYKER=1 node scripts\/run-tests\.mjs/);
});

// This spawns the guard without the marker, so it cannot itself hold inside
// the Stryker sandbox; skip it there like the guards it checks.
test('cli-support-matrix skips its src/attach.ts text guards under PLUK_UNDER_STRYKER', {
  skip: process.env.PLUK_UNDER_STRYKER === '1' && 'spawns the attach.ts text guard against instrumented source',
}, () => {
  const run = (env) => {
    const childEnv = { ...process.env, ...env };
    // node:test refuses to run files from inside another --test process.
    delete childEnv.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/cli-support-matrix.test.js'], {
      env: childEnv,
      encoding: 'utf-8',
      timeout: 60_000,
    });
  };
  const plain = run({ PLUK_UNDER_STRYKER: '' });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /^# skipped 0$/m, 'guards must run in a normal npm test');

  const sandboxed = run({ PLUK_UNDER_STRYKER: '1' });
  assert.equal(sandboxed.status, 0, sandboxed.stdout + sandboxed.stderr);
  assert.match(sandboxed.stdout, /^# skipped 6$/m, 'the six attach.ts text guards should skip');
  assert.match(sandboxed.stdout, /^# pass [1-9]/m, 'the README/bundled-patterns tests still run');
});

// Same shape for the src/subscriber.ts line-range guard in
// test/mutation-workflow.test.js: it parses the real source with the
// TypeScript compiler, so against the instrumented sandbox copy it reports a
// straddling node and fails every subscriber shard's dry run.
test('mutation-workflow skips its src/subscriber.ts line-range guard under PLUK_UNDER_STRYKER', {
  skip: process.env.PLUK_UNDER_STRYKER === '1' && 'spawns the subscriber.ts line-range guard against instrumented source',
}, () => {
  const run = (env) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/mutation-workflow.test.js'], {
      env: childEnv,
      encoding: 'utf-8',
      timeout: 120_000,
    });
  };
  const plain = run({ PLUK_UNDER_STRYKER: '' });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /^# skipped 0$/m, 'the guard must run in a normal npm test');

  const sandboxed = run({ PLUK_UNDER_STRYKER: '1' });
  assert.equal(sandboxed.status, 0, sandboxed.stdout + sandboxed.stderr);
  assert.match(sandboxed.stdout, /^# skipped 1$/m, 'only the subscriber.ts line-range guard should skip');
  assert.match(sandboxed.stdout, /^# pass [1-9]/m, 'the select-step and synthetic straddle tests still run');
});

test('importing the runner as a module does not spawn the suite', () => {
  // If the import at the top of this file had executed main(), the suite
  // would have recursed into itself; reaching this assertion proves the
  // import.meta.url guard held.
  assert.ok(true);
});
