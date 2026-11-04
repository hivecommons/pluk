// Warnings for silent pattern fallbacks (#457).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { parsePatternsContent, getPatterns, bundledPatternsDir } from '../dist/patterns.js';
import { watch } from '../dist/watch.js';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

function emptyDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-warn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parsePatternsContent warns naming the variable for an invalid regex', () => {
  const msgs = [];
  const p = parsePatternsContent("RATE_LIMIT_PATTERN='[unclosed'", 'claude', m => msgs.push(m));
  assert.equal(p.rateLimit, null);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /RATE_LIMIT_PATTERN in claude\.patterns is not a valid regular expression/);
  assert.match(msgs[0], /detector disabled/);
});

test('getPatterns warns once when patterns-dir lacks the file and falls back', t => {
  const dir = emptyDir(t);
  const msgs = [];
  const p = getPatterns('claude', dir, m => msgs.push(m));
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].includes(dir));
  assert.match(msgs[0], /using (bundled|builtin) patterns/);
  assert.deepEqual(p, getPatterns('claude'));
});

test('getPatterns reports when no pattern set exists at all', t => {
  const dir = emptyDir(t);
  const msgs = [];
  getPatterns('no-such-cli', dir, m => msgs.push(m));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /no pattern set found/);
});

test('getPatterns without a callback does not throw and is unchanged', t => {
  const dir = emptyDir(t);
  assert.deepEqual(getPatterns('claude', dir), getPatterns('claude'));
  assert.ok(bundledPatternsDir());
});

test('pluk patterns --patterns-dir warns on stderr and still prints the table', t => {
  const dir = emptyDir(t);
  const r = spawnSync(process.execPath, [cliPath, 'patterns', '--cli=claude', `--patterns-dir=${dir}`], { encoding: 'utf-8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /has no readable claude\.patterns/);
  assert.ok(r.stderr.includes(dir));
  assert.match(r.stdout, /Patterns for claude:/);
});

test('watch calls onWarn once when patterns-dir lacks the file', t => {
  const dir = emptyDir(t);
  const msgs = [];
  const handle = watch({ session: 'w', cli: 'claude', patternsDir: dir, input: new PassThrough(), onEvent: () => {}, onWarn: m => msgs.push(m) });
  handle.stop();
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].includes(dir));
});
