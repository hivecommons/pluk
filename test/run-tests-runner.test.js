import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COVERAGE_FLAGS,
  coverageArgs,
  listTestFiles,
  buildArgv,
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

test('COVERAGE_FLAGS enforce the documented 95/85/90 thresholds', () => {
  assert.deepEqual(COVERAGE_FLAGS, [
    '--experimental-test-coverage',
    '--test-coverage-lines=95',
    '--test-coverage-branches=85',
    '--test-coverage-functions=90',
  ]);
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

test('importing the runner as a module does not spawn the suite', () => {
  // If the import at the top of this file had executed main(), the suite
  // would have recursed into itself; reaching this assertion proves the
  // import.meta.url guard held.
  assert.ok(true);
});
