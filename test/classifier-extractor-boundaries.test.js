// Boundary cases of the src/classifier.ts data extractors (extractTool,
// extractDuration, extractResetTime). Each test pins one regex detail that
// the nightly Stryker run reported as a surviving mutant: the existing
// extractor tests only use single-digit minutes/hours, a single space after
// the bullet, and a `(tool)` suffix that happens to end the line, so a
// mutant that narrowed any of those quantifiers still passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Classifier, getPatterns, parsePatternsContent } from '../dist/index.js';

function makeClassifier(patterns = getPatterns('claude')) {
  return new Classifier({ session: 'ev-bounds', patterns, clock: () => 1000 });
}

// --- extractTool -----------------------------------------------------------

test('extractTool: the "(tool)" kind suffix only counts at end of line', () => {
  // TOOL_PAREN_RE is anchored with `$`; a parenthesised lowercase word in
  // the middle of the line is an argument, not the kind suffix, so the
  // bullet name must win.
  const ev = makeClassifier().classify('● Bash run (bash) then report');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_started');
  assert.equal(ev.data.tool, 'Bash');
});

test('extractTool: bullet name is read across multiple spaces after the bullet', () => {
  // TOOL_BULLET_RE uses `\s+`; the claude pattern set requires exactly one
  // space, so a custom pattern set is needed to reach the extractor.
  const patterns = parsePatternsContent("TOOL_START_PATTERN='^●'", 'custom');
  const ev = makeClassifier(patterns).classify('●   Read(src/index.ts)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_started');
  assert.equal(ev.data.tool, 'Read');
});

// --- extractDuration -------------------------------------------------------

test('extractDuration: multi-digit minutes are converted', () => {
  const ev = makeClassifier().classify('✓ Bash(npm test) (12m 3s)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_completed');
  assert.equal(ev.data.duration_ms, '723000');
});

test('extractDuration: minute form without a space before the seconds is accepted', () => {
  const ev = makeClassifier().classify('✓ Bash(npm test) (1m23s)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_completed');
  assert.equal(ev.data.duration_ms, '83000');
});

// --- extractResetTime ------------------------------------------------------

test('extractResetTime: two-digit hour is captured whole', () => {
  const ev = makeClassifier().classify('Claude usage limit reached. Your limit resets at 11:30pm.');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.resets_at, '11:30pm');
});

test('extractResetTime: a space between the hour and am/pm is part of the match', () => {
  const ev = makeClassifier().classify('Claude usage limit reached. Your limit resets at 4 pm.');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.resets_at, '4 pm');
});

test('extractResetTime: relative form accepts multi-digit counts', () => {
  const ev = makeClassifier().classify('rate limit reached — resets in 12 hours');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.resets_at, 'in 12 hours');
});

test('extractResetTime: relative form accepts the singular unit', () => {
  const ev = makeClassifier().classify('rate limit reached — resets in 1 hour');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.resets_at, 'in 1 hour');
});
