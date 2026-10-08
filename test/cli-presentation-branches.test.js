// Branch-coverage tests for the last unexercised paths in src/cli.ts:
//
//   cmdWatch   — the onEvent try/catch that swallows a console.log failure so
//                the pipe-pane process stays alive (the only place a stdout
//                write error can surface synchronously). This guard is
//                tripled by watch.ts's own onEvent wrapper and the
//                process-level uncaughtException handler, so the test pins
//                the contract across all three layers rather than the cli.ts
//                lines alone;
//   cmdSessions — the empty-table "Run dir:" fallback to resolveRunDir() when
//                neither --run-dir nor PLUK_RUN_DIR is given, and the cyan
//                coloring of an `idle` row;
//   cmdPatterns — the default `--cli=claude` and the "(none)" placeholder for
//                a CLI that defines no patterns at all.
//
// Same harness style as test/cli-branches.test.js: spawn dist/cli.js with a
// stub tmux on PATH. The watch test reuses test/fixtures/inject-fault.mjs
// (kind=stdout-throw) so nothing in production code grows a test seam.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const INJECT_FAULT = join(process.cwd(), 'test', 'fixtures', 'inject-fault.mjs');
const FAULT_MARKER = 'PLUK_TEST_FAULT_INJECTED';

const ANSI_CYAN = '\x1b[36m';
const ANSI_DIM = '\x1b[2m';

let scratch;
let stubBin;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pluk-cli-pres-'));
  stubBin = join(scratch, 'bin');
  mkdirSync(stubBin, { recursive: true });
  // Fake tmux: knows no sessions.
  writeFileSync(
    join(stubBin, 'tmux'),
    '#!/bin/sh\n[ "$1" = "has-session" ] && exit 1\n[ "$1" = "list-sessions" ] && exit 1\nexit 0\n',
  );
  chmodSync(join(stubBin, 'tmux'), 0o755);
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCli(args, { env = {}, input } = {}) {
  const baseEnv = { ...process.env };
  // The sessions tests below pin the run-dir fallback chain, so make sure no
  // ambient override from the host leaks into the child.
  delete baseEnv.PLUK_RUN_DIR;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    input,
    timeout: 15000,
    env: { ...baseEnv, PATH: `${stubBin}:${process.env.PATH}`, TERM_PROGRAM: '', ...env },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
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

// --- sessions: empty table falls back to resolveRunDir() ----------------------

test('sessions with no --run-dir and no PLUK_RUN_DIR reports the resolved default run dir', () => {
  // XDG_RUNTIME_DIR drives defaultRunDir(); point it at an empty scratch dir
  // so discovery finds nothing and the "Run dir:" line must come from
  // resolveRunDir(), not from a flag or env override.
  const xdg = mkdtempSync(join(scratch, 'xdg-'));
  const { code, stdout } = runCli(['sessions'], { env: { XDG_RUNTIME_DIR: xdg } });
  assert.equal(code, 0);
  assert.match(stdout, /No active pluk sessions found\./);
  assert.ok(
    stdout.includes(`Run dir: ${join(xdg, 'pluk')}`),
    `expected the XDG-derived default run dir, got: ${stdout}`,
  );
});

test('sessions with an explicit empty --run-dir echoes that dir, not the default', () => {
  const dir = makeRunDir();
  const { code, stdout } = runCli(['sessions', `--run-dir=${dir}`]);
  assert.equal(code, 0);
  assert.match(stdout, /No active pluk sessions found\./);
  assert.ok(stdout.includes(`Run dir: ${dir}`), `expected ${dir}, got: ${stdout}`);
});

// --- sessions: idle row is cyan, unknown row is dim -----------------------------

test('sessions table colors an idle row cyan and an unknown-state row dim', () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'agent-idle.jsonl'),
    [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'claude' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { to: 'idle' } }),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(dir, 'logs', 'agent-unknown.jsonl'),
    eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'gemini' } }) + '\n',
  );
  const { code, stdout } = runCli(['sessions', `--run-dir=${dir}`]);
  assert.equal(code, 0);
  const rows = stdout.split('\n');
  const idleRow = rows.find(r => r.startsWith('agent-idle'));
  const unknownRow = rows.find(r => r.startsWith('agent-unknown'));
  assert.ok(idleRow, `expected an agent-idle row, got: ${stdout}`);
  assert.ok(unknownRow, `expected an agent-unknown row, got: ${stdout}`);
  assert.ok(idleRow.includes(`${ANSI_CYAN}idle`), `idle state must be cyan: ${idleRow}`);
  assert.ok(unknownRow.includes(`${ANSI_DIM}unknown`), `unknown state must be dim: ${unknownRow}`);
  // Neither session is alive under the stub tmux: both rows carry the hollow dot.
  assert.ok(idleRow.includes('\u25CB') && unknownRow.includes('\u25CB'), `expected ○ dots: ${stdout}`);
});

// --- patterns: default CLI and "(none)" placeholder ------------------------------

test('patterns defaults to --cli=claude when the flag is absent', () => {
  const { code, stdout } = runCli(['patterns']);
  assert.equal(code, 0);
  assert.match(stdout, /Patterns for claude:/);
  // claude ships real idle/working regexes, so no field falls back to (none).
  assert.match(stdout, /^\s+idle\s+\x1b\[32m/m);
  assert.match(stdout, /^\s+working\s+\x1b\[32m/m);
});

test('patterns prints "(none)" for every field of a CLI with no pattern file', () => {
  const { code, stdout } = runCli(['patterns', '--cli=no-such-cli']);
  assert.equal(code, 0);
  assert.match(stdout, /Patterns for no-such-cli:/);
  const fields = [
    'idle', 'working', 'rateLimit', 'login', 'trustDialog', 'bypass',
    'toolStart', 'toolEnd', 'error', 'model', 'sessionEnd',
  ];
  for (const name of fields) {
    assert.ok(
      new RegExp(`^\\s+${name}\\s+${ANSI_DIM.replace('[', '\\[')}\\(none\\)`, 'm').test(stdout),
      `${name} should render as dim (none), got: ${stdout}`,
    );
  }
  assert.match(stdout, /Available CLIs: .*claude/);
});

// --- watch: a console.log failure inside onEvent is swallowed -----------------

function onExit(child) {
  return new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
}

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

function hasRawLine(stdout, line) {
  return stdout
    .split('\n')
    .filter(l => l.startsWith('{'))
    .some(l => {
      try {
        const e = JSON.parse(l);
        return e.type === 'raw_output' && e.data?.line === line;
      } catch {
        return false; // a chunk may end mid-line
      }
    });
}

test('watch keeps emitting events after console.log throws inside onEvent', async () => {
  const child = spawn(
    process.execPath,
    ['--import', INJECT_FAULT, CLI, 'watch', 'fault-stdout', '--cli=claude', '--include-raw'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        PLUK_TEST_FAULT: 'stdout-throw',
        // Arm on demand, not on a timer: a 50ms timer counts from the preload
        // and on a loaded host fires before the CLI has processed the baseline
        // line, so the baseline's own state_change becomes the dropped event.
        PLUK_TEST_FAULT_ON_SIGNAL: 'SIGUSR2',
      },
    },
  );
  const out = collector(child.stdout, 'stdout');
  const err = collector(child.stderr, 'stderr');
  const exited = onExit(child);
  const alive = p =>
    Promise.race([
      p,
      exited.then(({ code, signal }) => {
        throw new Error(`watch died early (code=${code} signal=${signal}): ${err.text}`);
      }),
    ]);

  // Baseline: the watcher is up and classifying before the fault is armed.
  // Wait for the baseline line's raw_output — watch emits it last for a line,
  // synchronously after any state_change — so every baseline event is on
  // stdout before SIGUSR2 arms the throwing console.log.
  child.stdin.write('esc to interrupt\n');
  await alive(out.waitFor(s => hasRawLine(s, 'esc to interrupt')));
  child.kill('SIGUSR2');
  await alive(err.waitFor(s => s.includes(`${FAULT_MARKER}:stdout-throw`)));
  const before = eventCount(out.text);

  // The first event after arming is lost to the throwing console.log and
  // must be swallowed by the onEvent catch; the ones after it flow again.
  child.stdin.write('first line hits the throwing console.log\n');
  child.stdin.write('second line is logged normally\n');
  child.stdin.write('third line is logged normally\n');
  await alive(out.waitFor(s => eventCount(s) >= before + 2));

  child.stdin.end();
  const { code, signal } = await exited;
  assert.equal(signal, null, `must not die from a signal (stderr: ${err.text})`);
  assert.equal(code, 0, `expected clean exit, stderr: ${err.text}`);
  assert.ok(
    !/synthetic/.test(err.text.replace(`${FAULT_MARKER}:stdout-throw`, '')),
    `the console.log failure must be swallowed silently, got: ${err.text}`,
  );
  const lines = out.text.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  const texts = lines.map(e => JSON.stringify(e.data));
  // The throw landed inside onEvent's console.log: exactly that one event is
  // gone, and the ones queued behind it were still delivered.
  assert.ok(
    !texts.some(t => /first line hits/.test(t)),
    `the event whose console.log threw must be the one dropped: ${out.text}`,
  );
  assert.ok(
    texts.some(t => /second line/.test(t)) && texts.some(t => /third line/.test(t)),
    `events after the swallowed failure must still reach stdout: ${out.text}`,
  );
});
