// Semantic pins for the non-claude bundled pattern files. patterns.test.js
// proves the copilot/gemini/goose/codex/aider patterns *compile* and match the
// inline BUILTIN_PATTERNS field-for-field, and classifier tests exercise the
// event machinery — but only ever with claude patterns. Nothing asserted that
// those regexes actually classify representative CLI output correctly, so an
// edit that still compiles but breaks a pattern (dropped alternative, bad
// escaping) would pass CI. These tests feed each CLI's classifier
// real-looking lines and pin the resulting event types and data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Classifier, getPatterns } from '../dist/index.js';

// Mutable clock so tests can step past the 2s state debounce deterministically.
function makeClassifier(cli) {
  const clock = { now: 1000 };
  const c = new Classifier({
    session: `sem-${cli}`,
    patterns: getPatterns(cli),
    clock: () => clock.now,
  });
  return { c, clock };
}

function classifyType(cli, line) {
  const { c } = makeClassifier(cli);
  const ev = c.classify(line);
  return ev ? ev.type : null;
}

// --- copilot ---------------------------------------------------------------

test('copilot: idle prompt and working spinner drive the state machine', () => {
  const { c, clock } = makeClassifier('copilot');
  let ev = c.classify('❯');
  assert.ok(ev, 'idle prompt should produce a state_change');
  assert.equal(ev.type, 'state_change');
  assert.deepEqual({ from: ev.data.from, to: ev.data.to }, { from: 'unknown', to: 'idle' });

  clock.now = 1010;
  ev = c.classify('◐ Working on your request');
  assert.ok(ev, 'spinner should produce a state_change');
  assert.equal(ev.data.to, 'working');

  // Fresh working evidence suppresses the always-drawn input box…
  clock.now = 1011;
  assert.equal(c.classify('❯'), null);
  // …until the debounce window has passed.
  clock.now = 1020;
  ev = c.classify('❯');
  assert.ok(ev, 'idle prompt after the debounce should flip back to idle');
  assert.equal(ev.data.to, 'idle');
});

test('copilot: "Esc to cancel" status row is working evidence', () => {
  const { c } = makeClassifier('copilot');
  const ev = c.classify('Esc to cancel');
  assert.ok(ev);
  assert.deepEqual({ type: ev.type, to: ev.data.to }, { type: 'state_change', to: 'working' });
});

test('copilot: usage-limit line emits rate_limit with the reset time', () => {
  const { c } = makeClassifier('copilot');
  const ev = c.classify('Copilot usage limit reached. Resets at 3:00pm.');
  assert.ok(ev);
  assert.equal(ev.type, 'rate_limit');
  assert.equal(ev.data.cli, 'copilot');
  assert.equal(ev.data.resets_at, '3:00pm');
});

test('copilot: device-code login prompt emits login_required', () => {
  const { c } = makeClassifier('copilot');
  const ev = c.classify('Device code: ABCD-1234');
  assert.ok(ev);
  assert.equal(ev.type, 'login_required');
  assert.equal(ev.data.cli, 'copilot');
});

test('copilot: trust dialog emits trust_dialog, never auto-approved', () => {
  const { c } = makeClassifier('copilot');
  const ev = c.classify('Do you trust the files in this workspace?');
  assert.ok(ev);
  assert.equal(ev.type, 'trust_dialog');
  assert.equal(ev.data.auto_approved, 'false');
});

test('copilot: tool bullet lines emit tool start/end with the (kind) suffix', () => {
  const { c } = makeClassifier('copilot');
  let ev = c.classify('● npm test (shell)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_started');
  assert.equal(ev.data.tool, 'shell');

  ev = c.classify('✓ npm test (shell)');
  assert.ok(ev);
  assert.equal(ev.type, 'tool_call_completed');
  assert.equal(ev.data.tool, 'shell');
});

test('copilot: error, model, and session-end lines classify correctly', () => {
  assert.equal(classifyType('copilot', 'Error: request failed'), 'error');
  assert.equal(classifyType('copilot', 'Using model: claude-sonnet-4'), 'model_changed');
  assert.equal(classifyType('copilot', 'Goodbye'), 'session_ended');
});

// --- gemini ----------------------------------------------------------------

test('gemini: bare ">" prompt is idle, Thinking/braille spinner is working', () => {
  const { c, clock } = makeClassifier('gemini');
  let ev = c.classify('>');
  assert.ok(ev, '">" prompt should produce a state_change');
  assert.equal(ev.data.to, 'idle');

  clock.now = 1010;
  ev = c.classify('Thinking about your request');
  assert.ok(ev);
  assert.equal(ev.data.to, 'working');

  clock.now = 1020;
  const { c: c2 } = makeClassifier('gemini');
  ev = c2.classify('⠋ Generating response');
  assert.ok(ev, 'braille spinner should be working evidence');
  assert.equal(ev.data.to, 'working');
});

test('gemini: quota and 429 lines emit rate_limit', () => {
  assert.equal(classifyType('gemini', 'quota exceeded, try again later'), 'rate_limit');
  assert.equal(classifyType('gemini', 'received HTTP 429 from upstream'), 'rate_limit');
});

test('gemini: gcloud login prompt emits login_required', () => {
  assert.equal(classifyType('gemini', 'Run gcloud auth login to continue'), 'login_required');
});

test('gemini: error, model, and session-end lines classify correctly', () => {
  assert.equal(classifyType('gemini', 'ERROR: invalid request'), 'error');
  assert.equal(classifyType('gemini', 'Using model: gemini-2.0-flash'), 'model_changed');
  assert.equal(classifyType('gemini', 'Session ended'), 'session_ended');
});

test('gemini: has no tool/trust patterns — bullet and trust lines emit nothing', () => {
  // TOOL_START/END and TRUST_DIALOG are deliberately empty in gemini.patterns
  // and must compile to null (match nothing), not an empty match-all regex.
  assert.equal(classifyType('gemini', '● npm test (shell)'), null);
  assert.equal(classifyType('gemini', 'Do you trust the files in this folder?'), null);
});

// --- goose -----------------------------------------------------------------

test('goose: "goose>" prompt is idle, thinking/processing is working', () => {
  const { c, clock } = makeClassifier('goose');
  let ev = c.classify('goose>');
  assert.ok(ev, 'goose> prompt should produce a state_change');
  assert.equal(ev.data.to, 'idle');

  clock.now = 1010;
  ev = c.classify('processing your request');
  assert.ok(ev);
  assert.equal(ev.data.to, 'working');
});

test('goose: rate-limit, login, error, model, and session-end lines classify', () => {
  assert.equal(classifyType('goose', 'too many requests'), 'rate_limit');
  assert.equal(classifyType('goose', 'login required'), 'login_required');
  assert.equal(classifyType('goose', 'panic: runtime error'), 'error');
  assert.equal(classifyType('goose', 'Using model: gpt-4o'), 'model_changed');
  assert.equal(classifyType('goose', 'Goodbye'), 'session_ended');
});

test('goose: tool bullet lines emit nothing (no tool patterns defined)', () => {
  assert.equal(classifyType('goose', '✓ npm test (shell)'), null);
});

// --- codex -----------------------------------------------------------------
// codex/aider shipped with no pattern file at all (#135), so their regexes
// were never exercised by anything but the compile/parity checks above. Pin
// their semantics the same way as copilot/gemini/goose.

test('codex: ">" and "❯" prompts are idle, "esc to interrupt"/Working is working', () => {
  const { c, clock } = makeClassifier('codex');
  let ev = c.classify('>');
  assert.ok(ev, '">" prompt should produce a state_change');
  assert.equal(ev.data.to, 'idle');

  clock.now = 1010;
  ev = c.classify('● Working (12s · esc to interrupt)');
  assert.ok(ev);
  assert.equal(ev.data.to, 'working');

  // The "❯" alternative must also count as the idle prompt once the
  // debounce window has passed.
  clock.now = 1020;
  ev = c.classify('❯');
  assert.ok(ev, '"❯" prompt after the debounce should flip back to idle');
  assert.equal(ev.data.to, 'idle');

  for (const line of ['esc to interrupt', '● Working', 'Working (3s)']) {
    const { c: c2 } = makeClassifier('codex');
    const w = c2.classify(line);
    assert.ok(w, `${line} should be working evidence`);
    assert.equal(w.data.to, 'working');
  }
});

test('codex: usage-limit, login, error, model, and session-end lines classify', () => {
  assert.equal(classifyType('codex', 'You have hit your usage limit'), 'rate_limit');
  assert.equal(classifyType('codex', 'Please log in to continue'), 'login_required');
  assert.equal(classifyType('codex', 'authentication required'), 'login_required');
  assert.equal(classifyType('codex', 'Error: request failed'), 'error');
  assert.equal(classifyType('codex', 'Using model: gpt-5-codex'), 'model_changed');
  assert.equal(classifyType('codex', 'switching model o3-mini'), 'model_changed');
  assert.equal(classifyType('codex', 'Session ended'), 'session_ended');
});

test('codex: has no tool/trust/bypass patterns — those lines emit nothing', () => {
  assert.equal(classifyType('codex', '● npm test (shell)'), null);
  assert.equal(classifyType('codex', '✓ npm test (shell)'), null);
  assert.equal(classifyType('codex', 'Do you trust the files in this folder?'), null);
});

// --- aider -----------------------------------------------------------------

test('aider: bare ">" prompt is idle, token counter is working', () => {
  const { c, clock } = makeClassifier('aider');
  let ev = c.classify('>');
  assert.ok(ev, '">" prompt should produce a state_change');
  assert.equal(ev.data.to, 'idle');

  clock.now = 1010;
  ev = c.classify('Tokens: 4.2k sent, 1.1k received. Cost: $0.01');
  assert.ok(ev, 'token counter should be working evidence');
  assert.equal(ev.data.to, 'working');
});

test('aider: ">" prompt is anchored — a ">" inside a line is not idle', () => {
  // IDLE_PATTERN is '^>\s*$'; a quoted reply or a diff marker containing ">"
  // must not flip the session to idle.
  assert.equal(classifyType('aider', '> quoted previous message'), null);
  assert.equal(classifyType('aider', 'a > b'), null);
  assert.equal(classifyType('aider', 'diff --git a/x b/x >'), null);
});

test('aider: rate-limit, login, error, model, and session-end lines classify', () => {
  assert.equal(classifyType('aider', 'quota exceeded for this model'), 'rate_limit');
  assert.equal(classifyType('aider', 'Please set your API key'), 'login_required');
  assert.equal(classifyType('aider', 'error: no such file'), 'error');
  assert.equal(classifyType('aider', 'FATAL: cannot continue'), 'error');
  assert.equal(classifyType('aider', 'Model: gpt-4o with diff edit format'), 'model_changed');
  assert.equal(classifyType('aider', 'Main model: claude-3-5-sonnet'), 'model_changed');
  assert.equal(classifyType('aider', 'Goodbye'), 'session_ended');
});

test('aider: has no tool/trust/bypass patterns — those lines emit nothing', () => {
  assert.equal(classifyType('aider', '● npm test (shell)'), null);
  assert.equal(classifyType('aider', 'Do you trust the files in this folder?'), null);
});

test('rate_limit: bare 429 inside other tokens is not a rate limit', () => {
  for (const cli of ['aider', 'codex', 'gemini', 'goose']) {
    for (const line of ['Read 1429 lines from src/app.ts', 'foo.ts:429', '4,429 tokens']) {
      assert.notEqual(classifyType(cli, line), 'rate_limit', `${cli}: ${line}`);
    }
    for (const line of ['HTTP 429 Too Many Requests', 'status 429', 'rate limit exceeded']) {
      assert.equal(classifyType(cli, line), 'rate_limit', `${cli}: ${line}`);
    }
  }
});

// --- omp -------------------------------------------------------------------

test('omp: busy tail is working, idle pane is idle', () => {
  const { c, clock } = makeClassifier('omp');
  let ev = c.classify(' ⎋ Reading skill improvement guidance');
  assert.deepEqual({ from: ev.data.from, to: ev.data.to }, { from: 'unknown', to: 'working' });
  clock.now = 4000;
  assert.equal(c.classify('⠧ 4m > ◑ GPT-5.6-Terra ▶──20%──'), null);
  ev = c.classify('╰─');
  assert.deepEqual({ from: ev.data.from, to: ev.data.to }, { from: 'working', to: 'idle' });
  assert.equal(classifyType('omp', '╰─                          ⇧⇥ to change thinking effort'), 'state_change');
});

test('omp: login, rate-limit, trust, error and session-end lines', () => {
  assert.equal(classifyType('omp', 'No API key found for anthropic.'), 'login_required');
  assert.equal(classifyType('omp', 'Error: 429 {"type":"rate_limit_error"}'), 'rate_limit');
  assert.equal(classifyType('omp', 'Resume this session with'), 'session_ended');
  assert.equal(classifyType('omp', 'Allow tool: bash'), 'trust_dialog');
  assert.equal(classifyType('omp', ' Error: provider exploded'), 'error');
});
