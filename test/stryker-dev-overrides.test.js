import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// @stryker-mutator/core pins minimatch ~10.2.x and typed-rest-client 2.3.1
// hard-pins qs 6.15.1; both carry published advisories (GHSA-g3hv-75wg-m249,
// GHSA-q8mj-m7cp-5q26, GHSA-x5fp-wj9c-mxmx) whose fixes live in releases that
// neither `npm audit fix` nor Dependabot can reach through those pins, so
// package.json overrides them inside the Stryker subtree only (#498). Pin
// the overrides and the resolved versions so a later grouped dependency bump
// cannot drop them without the suite noticing.

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));

function atLeast(actual, minimum) {
  const a = actual.split('.').map(Number);
  const m = minimum.split('.').map(Number);
  for (let i = 0; i < m.length; i++) {
    if (a[i] !== m[i]) return a[i] > m[i];
  }
  return true;
}

test('package.json overrides minimatch and qs inside the stryker subtree only', () => {
  const stryker = pkg.overrides?.['@stryker-mutator/core'];
  assert.ok(stryker, 'overrides must scope to @stryker-mutator/core, not the whole tree');
  assert.equal(stryker.minimatch, '^11.0.1', 'override @stryker-mutator/core > minimatch to ^11.0.1 (GHSA-g3hv-75wg-m249)');
  assert.equal(stryker['typed-rest-client']?.qs, '^6.17.1', 'override @stryker-mutator/core > typed-rest-client > qs to ^6.17.1');
  assert.deepEqual(Object.keys(pkg.overrides), ['@stryker-mutator/core'], 'no override may apply outside the stryker subtree');
});

test('package-lock.json resolves the overridden packages to patched releases', () => {
  assert.ok(atLeast(lock.packages['node_modules/minimatch'].version, '11.0.1'), 'lockfile must resolve minimatch >= 11.0.1');
  assert.ok(atLeast(lock.packages['node_modules/qs'].version, '6.17.1'), 'lockfile must resolve qs >= 6.17.1');
});
