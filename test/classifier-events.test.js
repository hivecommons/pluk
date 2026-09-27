// Event-emission branches of src/classifier.ts that the state-machine tests
// (classifier.test.js, issue #17) never reach: the per-line event checks
// (rate_limit, login_required, trust_dialog, bypass_permissions,
// tool_call_started/completed, model_changed, session_ended), their data
// extractors (extractTool, extractDuration, extractResetTime), and
// commandReceived(). Also pins the unknown-CLI null pattern set in
// src/patterns.ts getPatterns().
import test from 'node:test';
import assert from 'node:assert/strict';
import { Classifier, getPatterns, parsePatternsContent } from '../dist/index.js';

function makeClassifier(patterns = getPatterns('claude')) {
  return new Classifier({ session: 'ev-test', patterns, clock: () => 1000 });
}

test('rate_limit: absolute reset time is extracted into resets_at', () => {
  const c = makeClassifier();
  const line = 'Claude usage limit reached. Your limit resets at 4:30pm.';
  const ev = c.classify(line);
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.cli, 'claude');
  assert.equal(ev.data.message, line);
  assert.equal(ev.data.resets_at, '4:30pm');
});

test('rate_limit: relative reset time ("in N hours") is extracted', () => {
  const ev = makeClassifier().classify('rate limit reached — resets in 3 hours');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.resets_at, 'in 3 hours');
});

test('rate_limit: no recognizable reset time yields empty resets_at', () => {
  const ev = makeClassifier().classify('quota exhausted');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.resets_at, '');
});

test('login_required carries the cli and the prompt line', () => {
  const line = 'Please log in to continue';
  const ev = makeClassifier().classify(line);
  assert.ok(ev);
  assert.equal(ev.type, 'login_required');
  assert.deepEqual(ev.data, { cli: 'claude', prompt: line });
});

test('trust_dialog line emits a trust_dialog event, never auto-approved', () => {
  const line = 'Do you trust the files in this folder?';
  const ev = makeClassifier().classify(line);
  assert.ok(ev);
  assert.equal(ev.type, 'trust_dialog');
  assert.deepEqual(ev.data, { prompt: line, auto_approved: 'false' });
});

test('bypass_permissions prompt (without working footer) emits, never auto-approved', () => {
  // No "esc to interrupt": the line must reach the bypass check, not be
  // consumed as working evidence only.
  const line = 'bypass permissions on (shift+tab to cycle)';
  const ev = makeClassifier().classify(line);
  assert.ok(ev);
  assert.equal(ev.type, 'bypass_permissions');
  assert.deepEqual(ev.data, { prompt: line, auto_approved: 'false' });
});

test('tool_call_started: trailing "(tool)" wins over the bullet name', () => {
  const ev = makeClassifier().classify('● Bash command ls -la (bash)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_started');
  assert.equal(ev.data.tool, 'bash'); // TOOL_PAREN_RE, not the ● bullet
  assert.equal(ev.data.input_preview, '● Bash command ls -la (bash)');
});

test('tool_call_started: input_preview is truncated to 120 chars', () => {
  const long = '● Read(' + 'X'.repeat(200) + ')'; // uppercase: no "(tool)" paren match
  const ev = makeClassifier().classify(long);
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_started');
  assert.equal(ev.data.tool, 'Read'); // bullet fallback
  assert.equal(ev.data.input_preview.length, 120);
  assert.equal(ev.data.input_preview, long.slice(0, 120));
});

test('tool_call_completed: tool from ✓ bullet, duration from "(N.Ns)"', () => {
  const ev = makeClassifier().classify('✓ Read(src/classifier.ts) (2.3s)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_completed');
  assert.equal(ev.data.tool, 'Read');
  assert.equal(ev.data.duration_ms, '2.3');
});

test('tool_call_completed: non-seconds parenthetical yields empty duration', () => {
  const ev = makeClassifier().classify('✓ Bash(make build) (45 tokens)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_completed');
  assert.equal(ev.data.duration_ms, '');
});

test('extractTool falls back to "unknown" when no paren or bullet matches', () => {
  // claude tool patterns always contain ●/✓ (bullet match); a custom pattern
  // set is the only way a tool line reaches the "unknown" fallback.
  const patterns = parsePatternsContent("TOOL_START_PATTERN='^RUNNING '", 'custom');
  const ev = makeClassifier(patterns).classify('RUNNING the build step');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_started');
  assert.equal(ev.data.tool, 'unknown');
});

test('model_changed reports the announcing line as "to"', () => {
  const line = 'Switched to model claude-opus-4';
  const ev = makeClassifier().classify(line);
  assert.ok(ev);
  assert.equal(ev.type, 'model_changed');
  assert.deepEqual(ev.data, { from: '', to: line });
});

test('session_ended fires on the goodbye line and names the cli', () => {
  const ev = makeClassifier().classify('Goodbye!');
  assert.ok(ev);
  assert.equal(ev.type, 'session_ended');
  assert.deepEqual(ev.data, { cli: 'claude' });
});

test('event checks run in priority order: rate_limit outranks error', () => {
  // A line matching both RATE_LIMIT_PATTERN and ERROR_PATTERN must classify
  // as rate_limit — the checks array is ordered, first match returns.
  const ev = makeClassifier().classify('Error: rate limit reached');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
});

test('commandReceived pins seq to the 1000001 command band', () => {
  const c = makeClassifier();
  c.classify('Goodbye'); // bump normal seq to 1 first
  const ev = c.commandReceived('git status', 'operator');
  assert.equal(ev.type, 'command_received');
  assert.equal(ev.seq, 1000001);
  assert.deepEqual(ev.data, { text: 'git status', sender: 'operator' });
  assert.equal(ev.session, 'ev-test');
});

test('event sequence numbers increment across mixed event types', () => {
  const c = makeClassifier();
  const first = c.classify('quota exhausted');
  const second = c.classify('✓ Edit(file.ts) (1.0s)');
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
});

test('getPatterns for an unknown CLI returns the all-null pattern set', () => {
  const p = getPatterns('no-such-cli');
  assert.equal(p.cli, 'no-such-cli');
  for (const key of ['idle', 'working', 'rateLimit', 'login', 'trustDialog',
    'bypass', 'toolStart', 'toolEnd', 'error', 'model', 'sessionEnd']) {
    assert.equal(p[key], null, `${key} must be null`);
  }
  // And a classifier built from it classifies nothing.
  assert.equal(makeClassifier(p).classify('Error: anything at all'), null);
});
