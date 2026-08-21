// Regression tests for https://github.com/kubestellar/pluk/issues/17
// Claude Code state classification: working pane must not classify as idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Classifier, getPatterns } from '../dist/index.js';

// Lines exactly as rendered by Claude Code (post stripANSI), per issue #17.
const SPINNER_LINE = '✻ Concocting… (6m 44s · ↓ 27.9k tokens)';
const INPUT_BOX = '❯';
const WORKING_FOOTER = '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents';
const IDLE_FOOTER = '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const COMPLETED_SUMMARY = '✻ Brewed for 9m 52s · 1 shell still running';
const TRUST_DIALOG = 'Do you trust the files in this folder?';

const WORKING_FRAME = [SPINNER_LINE, '─'.repeat(40), INPUT_BOX, '─'.repeat(40), WORKING_FOOTER];
const IDLE_FRAME = [COMPLETED_SUMMARY, '─'.repeat(40), INPUT_BOX, '─'.repeat(40), IDLE_FOOTER];
const TRUST_FRAME = [TRUST_DIALOG, '❯ 1. Yes, I trust this folder', '  2. No, exit'];

function makeClassifier(clock) {
  return new Classifier({
    session: 'test',
    patterns: getPatterns('claude'),
    clock,
  });
}

function stateChanges(events) {
  return events
    .filter(e => e && e.type === 'state_change')
    .map(e => `${e.data.from}->${e.data.to}`);
}

test('issue #17 trace: ❯ then esc-to-interrupt within debounce window ends working (stream path)', () => {
  let t = 1000;
  const c = makeClassifier(() => t);
  const events = [];

  // Repaints of a working pane, one frame per second, lines in on-screen
  // order: spinner, input box (❯), status row with `esc to interrupt`.
  for (const tick of [1000, 1001, 1002, 1003]) {
    t = tick;
    for (const line of WORKING_FRAME) {
      events.push(c.classify(line));
    }
  }

  const changes = stateChanges(events);
  // The first ❯ may emit idle (the original bug's first verdict), but the
  // corrective working transition must NOT be dropped by the debounce.
  assert.equal(c.state, 'working');
  assert.equal(changes[changes.length - 1].endsWith('->working'), true);
});

test('issue #17: whole working frame classifies working regardless of line order (frame path)', () => {
  let t = 1000;
  const c = makeClassifier(() => t);

  const ev = c.classifyFrame(WORKING_FRAME.join('\n'));
  assert.ok(ev);
  assert.equal(ev.type, 'state_change');
  assert.deepEqual({ from: ev.data.from, to: ev.data.to }, { from: 'unknown', to: 'working' });
  assert.equal(c.state, 'working');

  // Repeated captures of the same working frame emit nothing new.
  t = 1005;
  assert.equal(c.classifyFrame(WORKING_FRAME), null);
  assert.equal(c.state, 'working');
});

test('at-rest pane (footer without esc-to-interrupt + ❯) classifies idle', () => {
  let t = 1000;
  const c = makeClassifier(() => t);

  // Frame path
  const ev = c.classifyFrame(IDLE_FRAME);
  assert.ok(ev);
  assert.equal(ev.data.to, 'idle');
  assert.equal(c.state, 'idle');

  // Stream path, fresh classifier
  const c2 = makeClassifier(() => t);
  const events = IDLE_FRAME.map(l => c2.classify(l));
  assert.equal(c2.state, 'idle');
  assert.deepEqual(stateChanges(events), ['unknown->idle']);
});

test('completed-turn summary (✻ Brewed …) does NOT classify as working', () => {
  let t = 1000;
  const c = makeClassifier(() => t);

  assert.equal(c.classify(COMPLETED_SUMMARY), null);
  assert.equal(c.state, 'unknown');

  // A finished-turn frame (summary + idle footer) must resolve idle.
  const ev = c.classifyFrame(IDLE_FRAME);
  assert.equal(ev.data.to, 'idle');
});

test('working pane returning to rest transitions back to idle', () => {
  let t = 1000;
  const c = makeClassifier(() => t);

  c.classifyFrame(WORKING_FRAME);
  assert.equal(c.state, 'working');

  // Turn completes: frames now show the summary + idle footer.
  t = 1010;
  c.classifyFrame(IDLE_FRAME);
  t = 1011;
  c.classifyFrame(IDLE_FRAME);
  assert.equal(c.state, 'idle');
});

test('debounce suppresses rapid flapping but the last state wins after the window', () => {
  let t = 1000;
  const c = makeClassifier(() => t);
  const events = [];

  events.push(c.classifyFrame(WORKING_FRAME)); // unknown -> working, emitted
  // Rapid flap inside the 2s window: none of these may emit.
  events.push(c.classifyFrame(IDLE_FRAME));
  events.push(c.classifyFrame(WORKING_FRAME));
  t = 1001;
  events.push(c.classifyFrame(IDLE_FRAME));

  assert.deepEqual(stateChanges(events), ['unknown->working']);
  assert.equal(c.state, 'working');

  // Window expires: the LAST verdict of the burst (idle) is emitted, not dropped.
  t = 1003;
  const ev = c.classifyFrame(IDLE_FRAME);
  assert.ok(ev);
  assert.deepEqual({ from: ev.data.from, to: ev.data.to }, { from: 'working', to: 'idle' });
  assert.equal(c.state, 'idle');
});

test('blocked trust-dialog frame yields no idle/working verdict and clears pending', () => {
  let t = 1000;
  const c = makeClassifier(() => t);

  assert.equal(c.classifyFrame(TRUST_FRAME), null);
  assert.equal(c.state, 'unknown');

  // A pending verdict must not survive into a blocked modal.
  c.classifyFrame(WORKING_FRAME); // unknown -> working
  t = 1001;
  c.classifyFrame(IDLE_FRAME); // pending idle, deferred
  c.classifyFrame(TRUST_FRAME); // modal outranks: pending discarded
  t = 1010;
  assert.equal(c.classifyFrame(TRUST_FRAME), null);
  assert.equal(c.state, 'working');
});

test('dead spinner glyphs and unreachable ● patterns are gone; tool events still fire', () => {
  const patterns = getPatterns('claude');
  for (const glyph of ['◐', '◑', '◒', '◓', '◉', '◎', '○', '✻', '✶', '✽', '✢']) {
    assert.equal(patterns.working.test(glyph), false, `${glyph} must not be a working marker`);
  }
  assert.equal(patterns.working.test(WORKING_FOOTER), true);

  // ● tool lines are tool_call_started events (TOOL_START_PATTERN), as before.
  const c = makeClassifier(() => 1000);
  const ev = c.classify('● Read(src/classifier.ts)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_started');
});
