// Guards changelog.d/ fragments so a malformed one fails the PR that adds
// it instead of surfacing at release time. CONTRIBUTING.md asks for
// `<category>-<slug>.md` files, and the release roll groups them into
// CHANGELOG.md's Keep-a-Changelog headings by the filename prefix; a
// fragment with an unknown prefix, an empty body, or a non-list body
// would be dropped or mis-sectioned when the next version is rolled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRAGMENT_DIR = join(ROOT, 'changelog.d');

export const CATEGORIES = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'];
export const FRAGMENT_NAME = new RegExp(`^(${CATEGORIES.join('|')})-[a-z0-9][a-z0-9-]*\\.md$`);

export function fragmentNameErrors(name) {
  if (name === 'README.md' || name === '.gitkeep') return [];
  if (!FRAGMENT_NAME.test(name)) {
    return [
      `${name}: must be named <category>-<slug>.md with category one of ${CATEGORIES.join('/')}`,
    ];
  }
  return [];
}

export function fragmentBodyErrors(name, body) {
  if (name === 'README.md' || name === '.gitkeep') return [];
  const errors = [];
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    errors.push(`${name}: fragment is empty`);
    return errors;
  }
  for (const line of lines) {
    if (!/^(- |  )/.test(line)) {
      errors.push(`${name}: every line must be a "- " bullet or a two-space continuation: ${JSON.stringify(line)}`);
      break;
    }
  }
  if (!body.endsWith('\n')) errors.push(`${name}: missing trailing newline`);
  return errors;
}

test('changelog.d/ fragment filenames follow <category>-<slug>.md', () => {
  const entries = readdirSync(FRAGMENT_DIR);
  const errors = entries.flatMap((name) => {
    if (statSync(join(FRAGMENT_DIR, name)).isDirectory()) return [`${name}: directories are not allowed in changelog.d/`];
    return fragmentNameErrors(name);
  });
  assert.deepEqual(errors, []);
});

test('changelog.d/ fragments are non-empty markdown bullet lists', () => {
  const entries = readdirSync(FRAGMENT_DIR).filter((n) => !statSync(join(FRAGMENT_DIR, n)).isDirectory());
  const errors = entries.flatMap((name) => fragmentBodyErrors(name, readFileSync(join(FRAGMENT_DIR, name), 'utf8')));
  assert.deepEqual(errors, []);
});

test('fragmentNameErrors rejects unknown categories and bad slugs', () => {
  assert.deepEqual(fragmentNameErrors('fixed-147.md'), []);
  assert.deepEqual(fragmentNameErrors('security-130-npx-fallback-pin.md'), []);
  assert.deepEqual(fragmentNameErrors('README.md'), []);
  assert.equal(fragmentNameErrors('feature-foo.md').length, 1);
  assert.equal(fragmentNameErrors('fixed-Foo.md').length, 1);
  assert.equal(fragmentNameErrors('fixed-.md').length, 1);
  assert.equal(fragmentNameErrors('fixed-foo.txt').length, 1);
  assert.equal(fragmentNameErrors('fixed.md').length, 1);
});

test('fragmentBodyErrors rejects empty, prose and unterminated fragments', () => {
  assert.deepEqual(fragmentBodyErrors('fixed-a.md', '- One line (#1).\n'), []);
  assert.deepEqual(fragmentBodyErrors('fixed-a.md', '- First.\n  continued.\n\n- Second.\n'), []);
  assert.deepEqual(fragmentBodyErrors('fixed-a.md', ''), ['fixed-a.md: fragment is empty']);
  assert.deepEqual(fragmentBodyErrors('fixed-a.md', '\n\n'), ['fixed-a.md: fragment is empty']);
  assert.equal(fragmentBodyErrors('fixed-a.md', 'Fixed a thing.\n').length, 1);
  assert.equal(fragmentBodyErrors('fixed-a.md', '- No newline').length, 1);
});
