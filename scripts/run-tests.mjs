#!/usr/bin/env node
// Test runner invoked by `npm test`.
//
// On Node >= 22 it enforces the same coverage thresholds as `npm run
// test:coverage` (lines 99 / branches 96 / functions 98). The
// --test-coverage-* flags do not exist on Node 20, so on older majors it
// falls back to a plain `node --test` run. This makes the Node 22 CI leg
// coverage-gated without any workflow change.
//
// test/** is excluded explicitly: Node 24+ drops test files from the report
// by default but Node 22 does not, so without the exclude the matrix legs
// gate different aggregates and a threshold that holds on 26 can fail on 22.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const COVERAGE_FLAGS = [
  '--experimental-test-coverage',
  '--test-coverage-exclude=test/**',
  '--test-coverage-lines=99',
  '--test-coverage-branches=96',
  '--test-coverage-functions=98',
];

// Coverage-threshold flags for the given Node major version; empty on
// majors that predate --test-coverage-* (added in Node 22).
export function coverageArgs(major) {
  return major >= 22 ? [...COVERAGE_FLAGS] : [];
}

export function listTestFiles(dir = 'test') {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => `${dir}/${f}`);
}

export function buildArgv(major, files) {
  return ['--test', ...coverageArgs(major), ...files];
}

function main() {
  const major = Number(process.versions.node.split('.')[0]);
  const files = listTestFiles();
  if (files.length === 0) {
    console.error('run-tests: no test/*.test.js files found');
    process.exit(1);
  }
  const result = spawnSync(process.execPath, buildArgv(major, files), {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
