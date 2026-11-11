// Pins the key=value parsing rules of parsePatternsContent that the nightly
// mutation run left unasserted: the existing tests only check that a parsed
// regex *matches* a sample, so a parser that silently drops the first and
// last character of every value (or stops stripping quotes at all) still
// passed. Asserting `.source` makes the exact value the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatternsContent } from '../dist/patterns.js';

const source = (p, field) => (p[field] instanceof RegExp ? p[field].source : p[field]);

test('parsePatternsContent keeps an unquoted value verbatim', () => {
  const p = parsePatternsContent('ERROR_PATTERN=^Error:', 'x');
  assert.equal(source(p, 'error'), '^Error:');
});

test('parsePatternsContent strips one matching pair of single or double quotes', () => {
  const p = parsePatternsContent(`IDLE_PATTERN='^idle$'\nWORKING_PATTERNS="^busy$"`, 'x');
  assert.equal(source(p, 'idle'), '^idle$');
  assert.equal(source(p, 'working'), '^busy$');
});

test('parsePatternsContent leaves mismatched or one-sided quotes in place', () => {
  const p = parsePatternsContent([
    `IDLE_PATTERN='mixed"`,
    `WORKING_PATTERNS="mixed'`,
    `ERROR_PATTERN='leading`,
    `MODEL_PATTERN=trailing'`,
    `LOGIN_PATTERN="leading`,
    `BYPASS_PATTERN=trailing"`,
  ].join('\n'), 'x');
  assert.equal(source(p, 'idle'), `'mixed"`);
  assert.equal(source(p, 'working'), `"mixed'`);
  assert.equal(source(p, 'error'), `'leading`);
  assert.equal(source(p, 'model'), `trailing'`);
  assert.equal(source(p, 'login'), `"leading`);
  assert.equal(source(p, 'bypass'), `trailing"`);
});

test('parsePatternsContent trims indentation and whitespace around the first "="', () => {
  const p = parsePatternsContent(`\t  IDLE_PATTERN   =   '^ready$'   \r\n  MODEL_PATTERN=a=b`, 'x');
  assert.equal(source(p, 'idle'), '^ready$');
  // Only the first "=" separates key from value; later ones belong to the pattern.
  assert.equal(source(p, 'model'), 'a=b');
});

test('parsePatternsContent ignores commented-out assignments, indented or not', () => {
  const p = parsePatternsContent([
    `# IDLE_PATTERN='from-comment'`,
    `   # WORKING_PATTERNS='from-indented-comment'`,
    `#ERROR_PATTERN='no-space-comment'`,
    `IDLE_PATTERN='real'`,
  ].join('\n'), 'x');
  assert.equal(source(p, 'idle'), 'real');
  assert.equal(p.working, null);
  assert.equal(p.error, null);
});

test('parsePatternsContent lets a later assignment override an earlier one', () => {
  const p = parsePatternsContent(`IDLE_PATTERN='first'\nIDLE_PATTERN='second'`, 'x');
  assert.equal(source(p, 'idle'), 'second');
});
