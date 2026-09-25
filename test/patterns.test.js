// Tests for src/patterns.ts — pattern file parsing and fallback resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePatternsContent,
  loadPatterns,
  listAvailableCLIs,
  bundledPatternsDir,
  getPatterns,
  BUILTIN_PATTERNS,
} from '../dist/patterns.js';

test('parsePatternsContent parses quoted values and skips comments/blank lines', () => {
  const content = `
# a comment
IDLE_PATTERN='❯\\s*$'
WORKING_PATTERNS="esc to interrupt"

not-an-assignment-line
ERROR_PATTERN=^Error:
`;
  const p = parsePatternsContent(content, 'claude');
  assert.equal(p.cli, 'claude');
  assert.ok(p.idle instanceof RegExp);
  assert.match('❯ ', p.idle);
  assert.match('press esc to interrupt now', p.working);
  assert.match('Error: boom', p.error);
  assert.equal(p.rateLimit, null);
  assert.equal(p.login, null);
});

test('parsePatternsContent maps every documented key to its field', () => {
  const content = [
    "IDLE_PATTERN='a'",
    "WORKING_PATTERNS='b'",
    "RATE_LIMIT_PATTERN='c'",
    "LOGIN_PATTERN='d'",
    "TRUST_DIALOG_PATTERN='e'",
    "BYPASS_PATTERN='f'",
    "TOOL_START_PATTERN='g'",
    "TOOL_END_PATTERN='h'",
    "ERROR_PATTERN='i'",
    "MODEL_PATTERN='j'",
    "SESSION_END_PATTERN='k'",
  ].join('\n');
  const p = parsePatternsContent(content, 'x');
  for (const field of ['idle', 'working', 'rateLimit', 'login', 'trustDialog', 'bypass', 'toolStart', 'toolEnd', 'error', 'model', 'sessionEnd']) {
    assert.ok(p[field] instanceof RegExp, `${field} should compile`);
  }
});

test('parsePatternsContent yields null for an invalid regex instead of throwing', () => {
  const p = parsePatternsContent("IDLE_PATTERN='[unclosed'", 'claude');
  assert.equal(p.idle, null);
});

test('parsePatternsContent ignores unknown variable names', () => {
  const p = parsePatternsContent("SOMETHING_ELSE='x'\nIDLE_PATTERN='y'", 'claude');
  assert.ok(p.idle instanceof RegExp);
  assert.equal(p.working, null);
});

test('loadPatterns reads a .patterns file from a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-patterns-'));
  try {
    writeFileSync(join(dir, 'mycli.patterns'), "IDLE_PATTERN='ready>$'\n");
    const p = loadPatterns(dir, 'mycli');
    assert.equal(p.cli, 'mycli');
    assert.match('ready>', p.idle);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAvailableCLIs lists .patterns basenames and returns [] for a missing dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-patterns-'));
  try {
    writeFileSync(join(dir, 'aaa.patterns'), '');
    writeFileSync(join(dir, 'bbb.patterns'), '');
    writeFileSync(join(dir, 'ignored.txt'), '');
    assert.deepEqual(listAvailableCLIs(dir).sort(), ['aaa', 'bbb']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(listAvailableCLIs('/nonexistent/pluk-patterns-dir'), []);
});

test('bundled patterns dir contains every builtin CLI', () => {
  const clis = listAvailableCLIs(bundledPatternsDir()).sort();
  assert.deepEqual(clis, Object.keys(BUILTIN_PATTERNS).sort());
});

test('getPatterns prefers an explicit patternsDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-patterns-'));
  try {
    writeFileSync(join(dir, 'claude.patterns'), "IDLE_PATTERN='CUSTOMIDLE'\n");
    const p = getPatterns('claude', dir);
    assert.match('CUSTOMIDLE', p.idle);
    assert.equal(p.working, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getPatterns falls back to bundled patterns when patternsDir lacks the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-patterns-'));
  try {
    const p = getPatterns('claude', dir);
    assert.ok(p.idle instanceof RegExp, 'bundled claude idle pattern should load');
    assert.match('esc to interrupt', p.working);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getPatterns for an unknown CLI returns an all-null set with the cli name', () => {
  const p = getPatterns('no-such-cli');
  assert.equal(p.cli, 'no-such-cli');
  for (const [k, v] of Object.entries(p)) {
    if (k === 'cli') continue;
    assert.equal(v, null, `${k} should be null`);
  }
});

test('inline builtin patterns compile for every CLI', () => {
  for (const cli of Object.keys(BUILTIN_PATTERNS)) {
    const p = parsePatternsContent(BUILTIN_PATTERNS[cli], cli);
    assert.ok(p.idle instanceof RegExp, `${cli} idle should compile`);
    assert.ok(p.error instanceof RegExp, `${cli} error should compile`);
  }
});
