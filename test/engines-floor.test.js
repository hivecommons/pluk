// Keeps the three places that state the supported Node floor in sync:
// package.json `engines.node` (what `npm install` warns on), the oldest
// major in .github/workflows/test.yml (what CI actually runs), and the
// CONTRIBUTING.md requirement (what contributors are told). CI once tested
// 20/22 while the docs said "20 or newer"; after the matrix moved to
// 22/24/26 nothing re-stated the floor, so a syntax or API only present on
// Node >= 22 could ship to a runtime the project still claimed to support.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

export function enginesFloor(packageJson) {
  const range = JSON.parse(packageJson).engines?.node;
  const m = /^>=(\d+)$/.exec(range ?? '');
  assert.ok(m, `package.json engines.node must be ">=<major>", got ${JSON.stringify(range)}`);
  return Number(m[1]);
}

export function matrixMajors(workflow) {
  const m = /^\s*node-version:\s*\[([^\]]+)\]\s*$/m.exec(workflow);
  assert.ok(m, 'test.yml must declare a node-version: [..] matrix');
  return m[1].split(',').map((s) => Number(s.trim())).sort((a, b) => a - b);
}

export function contributingFloor(contributing) {
  const m = /^- Node\.js (\d+) or newer\b/m.exec(contributing);
  assert.ok(m, 'CONTRIBUTING.md must state "- Node.js <major> or newer"');
  return Number(m[1]);
}

test('engines.node floor is the oldest major the Test matrix runs', () => {
  const floor = enginesFloor(read('package.json'));
  const majors = matrixMajors(read('.github/workflows/test.yml'));
  assert.equal(
    floor,
    majors[0],
    `package.json engines.node >=${floor} but test.yml only runs [${majors.join(', ')}]`,
  );
});

test('CONTRIBUTING.md states the same Node floor as engines.node', () => {
  assert.equal(contributingFloor(read('CONTRIBUTING.md')), enginesFloor(read('package.json')));
});

test('declared floor is new enough for the coverage gate in run-tests.mjs', () => {
  // scripts/run-tests.mjs only passes --test-coverage-* on Node >= 22; a lower
  // floor would promise a runtime on which the test suite is not coverage-gated.
  assert.ok(enginesFloor(read('package.json')) >= 22);
});

test('parsers reject malformed inputs instead of passing vacuously', () => {
  assert.throws(() => enginesFloor('{}'), /engines\.node/);
  assert.throws(() => enginesFloor('{"engines":{"node":"^22"}}'), /engines\.node/);
  assert.throws(() => matrixMajors('jobs: {}'), /node-version/);
  assert.throws(() => contributingFloor('- Node.js, any version'), /CONTRIBUTING/);
  assert.deepEqual(matrixMajors('        node-version: [26, 22, 24]\n'), [22, 24, 26]);
  assert.equal(contributingFloor('# x\n\n- Node.js 22 or newer (floor)\n'), 22);
});
