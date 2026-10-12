// Pins the default/fallback arms that the main suites never reach because
// every caller passes the optional value explicitly:
//
//   - watch() without `cli` classifies with the claude pattern set
//   - Classifier.classify('') is a no-op (no event, no seq consumed)
//   - state_change events omit `cli` when the pattern set has none
//   - defaultRunDir() falls back to `pluk-user` where process.getuid is absent
//   - rotateLogFileIfNeeded() leaves an oversized log with <= keepLines lines alone
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Classifier, getPatterns, parsePatternsContent } from '../dist/index.js';
import { watch } from '../dist/watch.js';
import { defaultRunDir, rotateLogFileIfNeeded } from '../dist/run-dir.js';

function settle(ms = 50) {
  return new Promise(r => setTimeout(r, ms));
}

// --- watch() cli default ---------------------------------------------------------

test('watch() without cli falls back to the claude pattern set', async () => {
  const input = new PassThrough();
  const events = [];
  const handle = watch({ session: 'wdefault', input, onEvent: e => events.push(e) });
  try {
    // A line the claude pattern set classifies; an all-null (unknown-CLI)
    // set would emit nothing but raw_output.
    input.write('Error: something exploded\n');
    await settle();
    const error = events.find(e => e.type === 'error');
    assert.ok(error, 'expected an error event from the claude patterns');
    assert.equal(error.data.message, 'Error: something exploded');
  } finally {
    handle.stop();
  }
});

// --- Classifier empty-line guard -------------------------------------------------

test('Classifier.classify("") returns null and does not consume a sequence number', () => {
  const c = new Classifier({ session: 'test', patterns: getPatterns('claude'), clock: () => 1000 });
  assert.equal(c.classify(''), null);
  assert.equal(c.state, 'unknown');

  // The next real event must still be seq 1: the empty line left no gap.
  const ev = c.classify('Error: boom');
  assert.ok(ev);
  assert.equal(ev.seq, 1);
});

// --- state_change without a cli tag ----------------------------------------------

test('state_change events omit data.cli when the pattern set has no cli name', () => {
  // parsePatternsContent keeps whatever cli name it is handed; an empty
  // one models a caller-built pattern set with no CLI identity.
  const content = ['IDLE_PATTERN=^❯$', 'WORKING_PATTERNS=esc to interrupt'].join('\n');
  const patterns = parsePatternsContent(content, '');
  assert.equal(patterns.cli, '');
  assert.ok(patterns.working, 'WORKING_PATTERNS must compile');

  // The first verdict lands immediately: the debounce window is measured
  // from the last state change, and there has been none yet.
  const c = new Classifier({ session: 'test', patterns, clock: () => 1000 });
  const ev = c.classify('esc to interrupt');
  assert.ok(ev && ev.type === 'state_change', 'expected a state_change event');
  assert.equal(ev.data.to, 'working');
  assert.equal(Object.hasOwn(ev.data, 'cli'), false);

  // Control: the same transition with a named set carries the tag.
  const named = new Classifier({ session: 'test', patterns: parsePatternsContent(content, 'mycli'), clock: () => 1000 });
  const tagged = named.classify('esc to interrupt');
  assert.equal(tagged.data.cli, 'mycli');
});

// --- defaultRunDir without process.getuid ---------------------------------------

test('defaultRunDir falls back to pluk-user when process.getuid is unavailable', () => {
  const originalXdg = process.env['XDG_RUNTIME_DIR'];
  const originalGetuid = process.getuid;
  delete process.env['XDG_RUNTIME_DIR'];
  // Windows exposes no process.getuid; model that platform here.
  process.getuid = undefined;
  try {
    assert.equal(defaultRunDir(), join(tmpdir(), 'pluk-user'));
  } finally {
    process.getuid = originalGetuid;
    if (originalXdg !== undefined) process.env['XDG_RUNTIME_DIR'] = originalXdg;
  }
});

// --- rotateLogFileIfNeeded with too few lines to trim -----------------------------

test('rotateLogFileIfNeeded leaves an oversized log alone when it has no more than keepLines lines', () => {
  const base = mkdtempSync(join(tmpdir(), 'pluk-fallbacks-'));
  try {
    const file = join(base, 'wide.jsonl');
    // Two lines, each far past maxBytes: over the byte threshold, but
    // trimming to the last 5 lines would keep everything, so no rewrite.
    const content = `{"pad":"${'x'.repeat(200)}"}\n{"pad":"${'y'.repeat(200)}"}\n`;
    writeFileSync(file, content);

    assert.strictEqual(rotateLogFileIfNeeded(file, { maxBytes: 10, keepLines: 5 }), false);
    assert.equal(readFileSync(file, 'utf-8'), content);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
