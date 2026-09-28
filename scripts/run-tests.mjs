#!/usr/bin/env node
// Test runner invoked by `npm test`.
//
// On Node >= 22 it enforces the same coverage thresholds as `npm run
// test:coverage` (lines 95 / branches 85 / functions 90). The
// --test-coverage-* flags do not exist on Node 20, so on older majors it
// falls back to a plain `node --test` run. This makes the Node 22 CI leg
// coverage-gated without any workflow change.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const COVERAGE_FLAGS = [
  '--experimental-test-coverage',
  '--test-coverage-lines=95',
  '--test-coverage-branches=85',
  '--test-coverage-functions=90',
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
