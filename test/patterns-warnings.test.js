// Warnings for silent pattern fallbacks (#457).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { parsePatternsContent, getPatterns, hasAnyPattern, bundledPatternsDir } from '../dist/patterns.js';
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

test('getPatterns stays silent when no pattern set exists at all (the CLI reports that itself)', t => {
  const dir = emptyDir(t);
  const msgs = [];
  const p = getPatterns('no-such-cli', dir, m => msgs.push(m));
  assert.equal(msgs.length, 0);
  assert.equal(hasAnyPattern(p), false);
});

test('pluk watch --patterns-dir with an unknown --cli warns exactly once on stderr', t => {
  const dir = emptyDir(t);
  const r = spawnSync(process.execPath, [cliPath, 'watch', 'w', '--cli=no-such-cli', `--patterns-dir=${dir}`], { encoding: 'utf-8', input: '' });
  assert.equal(r.status, 0);
  const lines = r.stderr.split('\n').filter(l => l.includes('pattern'));
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /no pattern set for --cli=no-such-cli/);
});

test('pluk watch --patterns-dir lacking the file warns once on stderr and falls back to bundled', t => {
  const dir = emptyDir(t);
  const r = spawnSync(process.execPath, [cliPath, 'watch', 'w', '--cli=claude', `--patterns-dir=${dir}`], { encoding: 'utf-8', input: '' });
  assert.equal(r.status, 0);
  const lines = r.stderr.split('\n').filter(l => l.includes('pattern'));
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /has no readable claude\.patterns; using bundled patterns/);
  assert.ok(lines[0].includes(dir));
  assert.doesNotMatch(r.stderr, /no pattern set/);
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
