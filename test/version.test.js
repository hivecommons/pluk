// Unit tests for src/version.ts — the package-version reader and the pinned
// npm spec `pluk attach` hands to its npx fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageVersion, plukPackageSpec } from '../dist/version.js';

const pkgVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')).version;

test('packageVersion reads the version from the adjacent package.json', () => {
  assert.equal(packageVersion(), pkgVersion);
});

test('plukPackageSpec pins the npx fallback to the running release by default', () => {
  assert.equal(plukPackageSpec(), `@hivecommons/pluk@${pkgVersion}`);
});

test('plukPackageSpec pins to an explicit version', () => {
  assert.equal(plukPackageSpec('1.2.3'), '@hivecommons/pluk@1.2.3');
});

test('plukPackageSpec drops the pin only when the version is unknown', () => {
  // Without a readable package.json there is nothing to pin to; the bare
  // name is the only spec that can still resolve.
  assert.equal(plukPackageSpec('unknown'), '@hivecommons/pluk');
});

test('packageVersion returns "unknown" when no package.json sits beside dist/', async () => {
  // Load a copy of the compiled module from a directory with no parent
  // package.json: the read fails and the reader must degrade to 'unknown'
  // (which plukPackageSpec turns into the bare, unpinned name) instead of
  // throwing out of `pluk attach`.
  const base = mkdtempSync(join(tmpdir(), 'pluk-version-test-'));
  try {
    const distCopy = join(base, 'dist');
    mkdirSync(distCopy);
    copyFileSync(join(process.cwd(), 'dist', 'version.js'), join(distCopy, 'version.js'));
    const orphan = await import(pathToFileURL(join(distCopy, 'version.js')).href);
    assert.equal(orphan.packageVersion(), 'unknown');
    assert.equal(orphan.plukPackageSpec(), '@hivecommons/pluk');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
