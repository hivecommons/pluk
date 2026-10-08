// Covers the two long-timer paths in src/cli.ts that no other test reaches
// because they only fire after 60 s (Subscriber file-wait timeout -> the
// cmdSubscribe `sub.on('error')` handler) or every 30 s (cmdWatch's
// log-rotation interval and its never-crash catch). The CLI is spawned with
// test/fixtures/fast-timers.mjs preloaded, which clamps those delays to
// milliseconds without touching the production source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const FAST_TIMERS = join(process.cwd(), 'test', 'fixtures', 'fast-timers.mjs');

function makeRunDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function spawnFast(args, env = {}) {
  return spawn(process.execPath, ['--import', FAST_TIMERS, CLI, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function onExit(child) {
  return new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
}

// A watch child that outlives a failed assertion keeps its stdio pipes open
// and so keeps this test process alive forever (CI only ends it via the job
// timeout, hiding the assertion). Always reap it.
function reapOnFailure(t, child) {
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
}

function waitFor(predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`${label} not met within ${timeoutMs}ms`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const sampleLine = i =>
  JSON.stringify({ v: 1, ts: '2026-01-01T00:00:00.000Z', seq: i, pid: 1, session: 's', pane: 'p', source: 't', type: 'raw_output', data: { i } });

// --- subscribe: file-wait timeout reaches the sub.on('error') handler ------------

test('subscribe exits 1 with a timeout error when the log file never appears', () => {
  const dir = makeRunDir('pluk-sub-timeout-');
  try {
    const res = spawnSync(
      process.execPath,
      ['--import', FAST_TIMERS, CLI, 'subscribe', 'never', `--run-dir=${dir}`],
      { encoding: 'utf-8', timeout: 20000, env: { ...process.env, PLUK_TEST_TIMER_CLAMP_MS: '5' } },
    );
    assert.equal(res.signal, null, 'must exit on its own, not be killed by the harness timeout');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Error:.*Timeout waiting for .*never\.jsonl/);
    assert.equal(res.stdout, '', 'no events may be emitted for a session that never logged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- watch: the rotation interval actually rotates the session log ---------------

test('watch rotates an oversized session log on its periodic check', async t => {
  const dir = makeRunDir('pluk-watch-rotate-');
  const logFile = join(dir, 'logs', 'rot.jsonl');
  try {
    const original = [0, 1, 2, 3, 4].map(sampleLine).join('\n') + '\n';
    const expected = [3, 4].map(sampleLine).join('\n') + '\n';
    writeFileSync(logFile, original);

    const child = spawnFast(['watch', 'rot', '--cli=claude', `--run-dir=${dir}`], {
      PLUK_LOG_MAX_BYTES: '1',
      PLUK_LOG_KEEP_LINES: '2',
    });
    reapOnFailure(t, child);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });

    // rotateLogFileIfNeeded overwrites the start of the file in place and
    // only then truncates, so a poll can observe a partially rewritten file.
    // Wait for the final content rather than "anything changed".
    let rotated = original;
    await waitFor(() => (rotated = readFileSync(logFile, 'utf-8')) === expected, { label: 'log rotation' })
      .catch(err => { throw new Error(`${err.message}; last content: ${JSON.stringify(rotated)}`); });
    assert.equal(rotated, expected, 'only the newest keepLines survive');

    const exit = onExit(child);
    child.kill('SIGINT');
    const { code, signal } = await exit;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.equal(stderr, '', 'rotation must be silent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch keeps classifying when the rotation check throws', async t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('read-only file does not block writes for root');
    return;
  }
  const dir = makeRunDir('pluk-watch-rotate-fail-');
  const logFile = join(dir, 'logs', 'rotfail.jsonl');
  try {
    const original = [0, 1, 2].map(sampleLine).join('\n') + '\n';
    writeFileSync(logFile, original);
    // stat() and read() succeed, so rotateLogFileIfNeeded gets as far as the
    // rewrite, which EACCES must turn into a throw inside the interval callback.
    chmodSync(logFile, 0o444);

    const child = spawnFast(['watch', 'rotfail', '--cli=claude', `--run-dir=${dir}`], {
      PLUK_LOG_MAX_BYTES: '1',
      PLUK_LOG_KEEP_LINES: '1',
    });
    reapOnFailure(t, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    // Let several (clamped) rotation ticks fail before proving the
    // classifier is still alive.
    await new Promise(r => setTimeout(r, 200));
    child.stdin.write('esc to interrupt\n');
    await waitFor(() => stdout.includes('"type":"state_change"'), { label: 'state_change event' });

    const exit = onExit(child);
    child.kill('SIGINT');
    const { code, signal } = await exit;
    assert.equal(signal, null, 'a throwing rotation check must never kill watch');
    assert.equal(code, 0);
    assert.equal(stderr, '', 'rotation failures are swallowed, not reported');
    assert.equal(readFileSync(logFile, 'utf-8'), original, 'the unwritable log is left untouched');
  } finally {
    chmodSync(logFile, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});
