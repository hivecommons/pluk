// Covers the two cli.ts contracts that no other suite exercises end to end:
//
//   1. The pipe-pane survival guards in cmdWatch. `pluk watch` is the one
//      process tmux keeps alive for a whole session, so a closed stdout
//      reader (EPIPE) must never take it down — the stdout/stdin 'error'
//      no-ops and installPipePaneErrorHandlers exist for exactly that.
//      Without them the process dies with "Unhandled 'error' event: write
//      EPIPE" (verified by removing the handlers from dist/cli.js).
//   2. The --diagnostics flag plumbing for both commands: the snapshot
//      closures passed to startDiagnostics (watcher.stats / sub.stats), the
//      periodic tick, and the final summary written on exit/SIGINT. The
//      diagnostics module itself is unit-tested in test/diagnostics.test.js;
//      this pins that the CLI wires it to real counters and to stderr only.
//
// Same spawn harness style as test/cli-error-paths.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let scratch; // per-run temp root
let stubBin; // dir holding a fake tmux so sessions/has-session never hit a real server

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pluk-cli-guards-'));
  stubBin = join(scratch, 'bin');
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, 'tmux'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stubBin, 'tmux'), 0o755);
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function spawnCli(args) {
  return spawn(process.execPath, [CLI, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  });
}

function onExit(child) {
  return new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
}

/** Resolve once `predicate(accumulated)` holds for the given stream; reject on timeout. */
function waitFor(stream, predicate, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`${label} not seen within ${timeoutMs}ms; got: ${buf}`)),
      timeoutMs,
    );
    stream.on('data', d => {
      buf += d;
      if (predicate(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
  });
}

function diagnosticsLines(stderr) {
  return stderr
    .split('\n')
    .filter(l => l.startsWith('{"pluk_diagnostics"'))
    .map(l => JSON.parse(l));
}

function makeRunDir() {
  const dir = mkdtempSync(join(scratch, 'run-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function eventLine({ ts, type = 'raw_output', data = {} }) {
  return JSON.stringify({
    v: 1, ts, seq: 0, pid: 1, session: 's', pane: 'p', source: 't', type, data,
  });
}

// --- 1. pipe-pane survival: stdout reader goes away mid-stream -------------------

test('watch survives EPIPE on stdout and still exits 0 when stdin ends', async () => {
  const child = spawnCli(['watch', 'epipe-watch', '--cli=claude', '--include-raw']);
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });

  const firstEvent = waitFor(child.stdout, out => out.includes('"type":'), 'first event');
  child.stdin.write('esc to interrupt\n');
  await firstEvent;

  // Close our end of the pipe: the next stdout write in the child fails with
  // EPIPE. Keep feeding input afterwards so the child actually attempts
  // further writes (enough volume to defeat any kernel pipe buffering).
  child.stdout.destroy();
  for (let i = 0; i < 200; i++) {
    child.stdin.write(`esc to interrupt\n${'x'.repeat(2000)}\n`);
  }
  child.stdin.end();

  const { code, signal } = await onExit(child);
  assert.equal(signal, null, 'must not die from a signal');
  assert.equal(code, 0, `expected clean exit, stderr: ${stderr}`);
  assert.ok(!/EPIPE/.test(stderr), `EPIPE must be swallowed, got: ${stderr}`);
  assert.ok(!/Unhandled 'error' event/.test(stderr), `no unhandled error, got: ${stderr}`);
});

// --- 2. --diagnostics wiring: watch -------------------------------------------------

test('watch --diagnostics writes a final watch summary to stderr only', async () => {
  const child = spawnCli(['watch', 'diag-watch', '--cli=claude', '--diagnostics']);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  child.stdin.write('esc to interrupt\n');
  child.stdin.write('this line matches nothing\n');
  child.stdin.end();

  const { code } = await onExit(child);
  assert.equal(code, 0);

  // Stdout carries only events — never a diagnostics line.
  const outLines = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(outLines.length >= 1, `expected events on stdout, got: ${stdout}`);
  assert.ok(outLines.every(l => l.pluk_diagnostics === undefined), 'diagnostics must not leak to stdout');

  // Exactly one final summary, carrying the live watcher counters.
  const diags = diagnosticsLines(stderr);
  assert.equal(diags.length, 1, `expected one final summary, got: ${stderr}`);
  const [final] = diags;
  assert.equal(final.command, 'watch');
  assert.equal(final.final, true);
  assert.equal(final.linesSeen, 2, 'watcher.stats() must be the live snapshot');
  assert.equal(final.eventsEmitted, outLines.length);
  for (const key of ['framesPolled', 'captureFailures', 'classifyErrors', 'inputErrors', 'eventsFiltered']) {
    assert.equal(typeof final[key], 'number', `missing watch counter ${key}`);
  }
  assert.ok(!('session' in final), 'summary must not name the session');
});

// --- 2. --diagnostics wiring: subscribe --------------------------------------------

test('subscribe --diagnostics=<seconds> emits periodic ticks and a final summary on SIGINT', async () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'diag-sub.jsonl'),
    [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'idle' } }),
      'not json at all',
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'raw_output', data: { text: 'x' } }),
    ].join('\n') + '\n',
  );
  const child = spawnCli([
    'subscribe', 'diag-sub', `--run-dir=${dir}`, '--from-beginning',
    '--filter=state_change', '--diagnostics=1',
  ]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });

  // A periodic (final:false) tick proves the interval fires with the
  // subscriber's own counters, not a static snapshot.
  await waitFor(
    child.stderr,
    s => { stderr = s; return /"final":false/.test(s); },
    'periodic diagnostics tick',
    15000,
  );
  child.stderr.on('data', d => { stderr += d; });
  const exit = onExit(child);
  child.kill('SIGINT');
  const { code, signal } = await exit;
  assert.equal(signal, null);
  assert.equal(code, 0);

  const diags = diagnosticsLines(stderr);
  const tick = diags.find(d => d.final === false);
  const final = diags.find(d => d.final === true);
  assert.ok(tick, `no periodic tick in: ${stderr}`);
  assert.ok(final, `no final summary in: ${stderr}`);
  for (const d of [tick, final]) {
    assert.equal(d.command, 'subscribe');
    assert.equal(d.linesRead, 3, 'sub.stats() must be the live snapshot');
    assert.equal(d.malformedLines, 1);
    assert.equal(d.eventsFiltered, 1);
    assert.equal(d.eventsEmitted, 1);
    assert.ok(!('session' in d), 'summary must not name the session');
  }
  // Diagnostics never reach stdout, which carries only the filtered event.
  const outLines = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(outLines.length, 1);
  assert.equal(outLines[0].type, 'state_change');
});
