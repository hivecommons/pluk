// Fault-injection coverage for the process-level survival guards in cmdWatch.
//
// `pluk watch` is the single process tmux keeps alive for a whole pipe-pane
// session. Besides the stdout EPIPE case (pinned in
// test/cli-pipe-pane-guards.test.js), cli.ts installs three more guards that
// no other suite ever fires:
//
//   process.on('uncaughtException', () => {})   // installPipePaneErrorHandlers
//   process.on('unhandledRejection', () => {})  // installPipePaneErrorHandlers
//   process.stdin.on('error', () => {})         // cmdWatch
//
// (The stdin guard is doubled by the watcher's own input 'error' handler in
// watch.ts, so that test pins the contract across both layers rather than the
// cli.ts line alone.)
//
// Each test injects the matching fault from outside via the
// test/fixtures/inject-fault.mjs preload (no seam in production code), then
// proves the watcher keeps classifying input afterwards and still exits 0
// when stdin ends. A control test shows the same injection kills an
// unguarded Node process, so a regression that drops a handler would turn
// these tests red rather than silently pass.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const INJECT_FAULT = join(process.cwd(), 'test', 'fixtures', 'inject-fault.mjs');
const FAULT_MARKER = 'PLUK_TEST_FAULT_INJECTED';

let scratch;
let stubBin;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pluk-cli-faults-'));
  stubBin = join(scratch, 'bin');
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, 'tmux'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stubBin, 'tmux'), 0o755);
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function spawnWatchWithFault(kind, session) {
  return spawn(
    process.execPath,
    ['--import', INJECT_FAULT, CLI, 'watch', session, '--cli=claude', '--include-raw'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        PLUK_TEST_FAULT: kind,
        PLUK_TEST_FAULT_DELAY_MS: '50',
      },
    },
  );
}

function onExit(child) {
  return new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
}

/** Accumulates a stream and resolves once `predicate(accumulated)` holds. */
function collector(stream, label, timeoutMs = 10000) {
  let buf = '';
  const waiters = [];
  stream.on('data', d => {
    buf += d;
    for (const w of waiters.splice(0)) {
      if (!w.check()) waiters.push(w);
    }
  });
  return {
    get text() {
      return buf;
    },
    waitFor(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label}: condition not met within ${timeoutMs}ms; got: ${buf}`)),
          timeoutMs,
        );
        const check = () => {
          if (predicate(buf)) {
            clearTimeout(timer);
            resolve(buf);
            return true;
          }
          return false;
        };
        if (!check()) waiters.push({ check });
      });
    },
  };
}

function eventCount(stdout) {
  return stdout.split('\n').filter(l => l.startsWith('{')).length;
}

async function assertWatchSurvives(kind) {
  const child = spawnWatchWithFault(kind, `fault-${kind}`);
  const out = collector(child.stdout, 'stdout');
  const err = collector(child.stderr, 'stderr');
  const exited = onExit(child);
  // A guard regression kills the child immediately; surface that as the
  // failure instead of waiting out the stream timeout.
  const alive = p =>
    Promise.race([
      p,
      exited.then(({ code, signal }) => {
        throw new Error(`watch died early after ${kind} (code=${code} signal=${signal}): ${err.text}`);
      }),
    ]);

  // Baseline: the watcher is up and classifying before the fault lands.
  child.stdin.write('esc to interrupt\n');
  await alive(out.waitFor(s => eventCount(s) >= 1));

  // The preload announces the fault after it has fired.
  await alive(err.waitFor(s => s.includes(`${FAULT_MARKER}:${kind}`)));
  const before = eventCount(out.text);

  // Post-fault: input must still be read and events still emitted.
  child.stdin.write('esc to interrupt\n');
  child.stdin.write('still alive after the fault\n');
  await alive(out.waitFor(s => eventCount(s) >= before + 2));

  child.stdin.end();
  const { code, signal } = await exited;
  assert.equal(signal, null, `must not die from a signal (stderr: ${err.text})`);
  assert.equal(code, 0, `expected clean exit after ${kind}, stderr: ${err.text}`);
  assert.ok(
    !/synthetic/.test(err.text.replace(`${FAULT_MARKER}:${kind}`, '')),
    `the ${kind} fault must be swallowed silently, got: ${err.text}`,
  );
  assert.ok(!/Unhandled 'error' event/.test(err.text), `no unhandled error, got: ${err.text}`);
}

test('watch survives an uncaught exception and keeps emitting events', async () => {
  await assertWatchSurvives('throw');
});

test('watch survives an unhandled promise rejection and keeps emitting events', async () => {
  await assertWatchSurvives('reject');
});

test("watch survives an 'error' event on stdin and keeps emitting events", async () => {
  await assertWatchSurvives('stdin-error');
});

// --- control: the injected faults are lethal without the guards -------------------

test('control: the same injected faults kill an unguarded Node process', () => {
  for (const kind of ['throw', 'reject']) {
    const result = spawnSync(
      process.execPath,
      ['--import', INJECT_FAULT, '-e', 'setInterval(() => {}, 1000)'],
      {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, PLUK_TEST_FAULT: kind, PLUK_TEST_FAULT_DELAY_MS: '20' },
      },
    );
    assert.equal(result.signal, null, `${kind}: control run must not time out`);
    assert.notEqual(result.status, 0, `${kind}: an unguarded process must die from the fault`);
    assert.match(result.stderr, /synthetic/, `${kind}: the fault must surface as the crash cause`);
  }
});
