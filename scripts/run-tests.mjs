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

const major = Number(process.versions.node.split('.')[0]);

const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => `test/${f}`);

if (files.length === 0) {
  console.error('run-tests: no test/*.test.js files found');
  process.exit(1);
}

const args = ['--test'];
if (major >= 22) {
  args.push(
    '--experimental-test-coverage',
    '--test-coverage-lines=95',
    '--test-coverage-branches=85',
    '--test-coverage-functions=90',
  );
}

const result = spawnSync(process.execPath, [...args, ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
