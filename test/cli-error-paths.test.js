// Error-path and signal-handling tests for src/cli.ts, plus the branches of
// sessions.ts / watch.ts they exercise end-to-end. Complements test/cli.test.js,
// which covers the happy paths: here we pin the version fallback, subscribe
// failure exits, SIGINT handlers, capture-mode polling, and the sessions
// command's degraded modes (tmux missing, unreadable log file).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let scratch; // per-run temp root
let stubBin; // dir holding fake tmux (capture-pane variant)

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pluk-cli-err-'));
  stubBin = join(scratch, 'bin');
  mkdirSync(stubBin, { recursive: true });

  // Fake tmux: capture-pane prints a frame the claude patterns classify as
  // "working"; list-sessions prints nothing; everything else succeeds.
  writeFileSync(
    join(stubBin, 'tmux'),
    `#!/bin/sh
if [ "$1" = "capture-pane" ]; then
  printf 'esc to interrupt\\n'
fi
exit 0
`,
  );
  chmodSync(join(stubBin, 'tmux'), 0o755);
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCli(args, { argv1 = CLI, env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [argv1, ...args], {
    encoding: 'utf-8',
    input,
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      ...env,
    },
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

/**
 * Spawn the CLI, wait until `predicate(stdout)` holds, then SIGINT it and
 * resolve with { code, signal, stdout }. Rejects if the predicate never holds.
 */
function spawnUntil(args, predicate, { timeoutMs = 10000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        ...env,
      },
    });
    let out = '';
    let settledExit;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`condition not met within ${timeoutMs}ms; got: ${out}`));
    }, timeoutMs);
    child.stdout.on('data', d => {
      out += d;
      if (predicate(out) && !settledExit) {
        settledExit = true;
        child.kill('SIGINT');
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (settledExit) {
        resolve({ code, signal, stdout: out });
      } else {
        reject(new Error(`exited early (code=${code}, signal=${signal}); got: ${out}`));
      }
    });
  });
}

// --- version fallback ----------------------------------------------------------

test('version falls back to "unknown" when package.json is missing', () => {
  // Copy dist/ somewhere with no adjacent package.json so packageVersion()
  // takes its catch branch instead of silently reporting a wrong version.
  const isolated = join(scratch, 'no-pkg');
  cpSync(join(process.cwd(), 'dist'), join(isolated, 'dist'), { recursive: true });
  const { code, stdout } = runCli(['version'], { argv1: join(isolated, 'dist', 'cli.js') });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '@hivecommons/pluk unknown');
});

// --- subscribe failure exits -----------------------------------------------------

test('subscribe rejects a path-traversal session name and exits 1', () => {
  const dir = makeRunDir();
  const { code, stderr } = runCli(['subscribe', '../evil', `--run-dir=${dir}`]);
  assert.equal(code, 1);
  assert.match(stderr, /Error:/);
  assert.match(stderr, /session name/i);
});

test('subscribe exits 1 when the log path exists but cannot be opened', () => {
  // A directory where the .jsonl file should be: stat() succeeds, so the
  // file-wait loop ends immediately, then open() fails (EISDIR) and the
  // start().catch handler must report it and exit non-zero.
  const dir = makeRunDir();
  mkdirSync(join(dir, 'logs', 'trap.jsonl'));
  const { code, stderr } = runCli(['subscribe', 'trap', `--run-dir=${dir}`]);
  assert.equal(code, 1);
  assert.match(stderr, /Error:/);
});

test('subscribe --verbose --filter replays matching events and logs progress', async () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'filt.jsonl'),
    [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'raw_output', data: { line: 'noise' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { to: 'idle' } }),
    ].join('\n') + '\n',
  );
  const child = spawn(
    process.execPath,
    [CLI, 'subscribe', 'filt', `--run-dir=${dir}`, '--from-beginning',
      '--filter=state_change', '--verbose'],
    { env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` } },
  );
  let out = '';
  let errOut = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { errOut += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no event seen; got: ${out}`)), 10000);
    child.stdout.on('data', () => {
      if (out.includes('"type":"state_change"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  }).finally(() => child.kill('SIGINT'));
  const lines = out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(lines.every(ev => ev.type === 'state_change'), `raw_output leaked: ${out}`);
  assert.match(errOut, /\[pluk:sub\]/, 'verbose progress log expected on stderr');
});

test('subscribe exits 0 on SIGINT while tailing', async () => {
  // Pins cmdSubscribe's SIGINT handler (sub.stop() + exit 0): without it the
  // default disposition would kill the process with a non-zero signal death.
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'sig-sub.jsonl'),
    eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'idle' } }) + '\n',
  );
  const child = spawn(
    process.execPath,
    [CLI, 'subscribe', 'sig-sub', `--run-dir=${dir}`, '--from-beginning'],
    { env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` } },
  );
  let out = '';
  child.stdout.on('data', d => { out += d; });
  // Wait until the replayed event proves the tail loop is live (and the
  // SIGINT handler is installed) before delivering the signal.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no event seen; got: ${out}`)), 10000);
    child.stdout.on('data', () => {
      if (out.includes('"type":"state_change"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGINT');
  const { code, signal } = await exit;
  assert.equal(signal, null, 'handler must catch SIGINT, not die from it');
  assert.equal(code, 0);
});

// --- watch signal handling and capture mode --------------------------------------

test('watch (stream) exits 0 on SIGINT', async () => {
  const child = spawn(process.execPath, [CLI, 'watch', 'sig-stream', '--cli=claude'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  });
  // Give the process a moment to install its SIGINT handler.
  await new Promise(r => setTimeout(r, 500));
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGINT');
  const { code, signal } = await exit;
  assert.equal(signal, null, 'handler must catch SIGINT, not die from it');
  assert.equal(code, 0);
});

test('watch --capture=<ms> polls tmux frames, classifies them, and stops on SIGINT', async () => {
  const { code, signal, stdout } = await spawnUntil(
    ['watch', 'cap-sess', '--cli=claude', '--capture=50'],
    out => out.includes('"type":"state_change"'),
  );
  assert.equal(signal, null);
  assert.equal(code, 0);
  const ev = JSON.parse(stdout.trim().split('\n')[0]);
  assert.equal(ev.type, 'state_change');
  assert.equal(ev.session, 'cap-sess');
  assert.equal(ev.data.to, 'working', 'the "esc to interrupt" frame means working');
  assert.equal(ev.source, 'capture-pane');
});

test('watch --capture without a value uses the default poll interval', async () => {
  const { code, stdout } = await spawnUntil(
    ['watch', 'cap-default', '--cli=claude', '--capture'],
    out => out.includes('"type":"state_change"'),
  );
  assert.equal(code, 0);
  const ev = JSON.parse(stdout.trim().split('\n')[0]);
  assert.equal(ev.session, 'cap-default');
});

// --- sessions degraded modes -------------------------------------------------------

test('sessions reports tmuxAlive=false when tmux is not installed (PLUK_RUN_DIR)', () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'ghost.jsonl'),
    [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'claude' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { to: 'idle' } }),
    ].join('\n') + '\n',
  );
  const { code, stdout } = runCli(['sessions', '--json'], {
    env: { PATH: '/nonexistent-dir', PLUK_RUN_DIR: dir }, // no tmux anywhere
  });
  assert.equal(code, 0);
  const sessions = JSON.parse(stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session, 'ghost');
  assert.equal(sessions[0].tmuxAlive, false);
});

test('sessions skips a log file it cannot read instead of crashing', t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: chmod 000 still readable');
    return;
  }
  const dir = makeRunDir();
  const good = join(dir, 'logs', 'ok.jsonl');
  const bad = join(dir, 'logs', 'locked.jsonl');
  writeFileSync(good, eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'claude' } }) + '\n');
  writeFileSync(bad, eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'goose' } }) + '\n');
  chmodSync(bad, 0o000);
  try {
    const { code, stdout } = runCli(['sessions', `--run-dir=${dir}`, '--json']);
    assert.equal(code, 0);
    const sessions = JSON.parse(stdout);
    assert.deepEqual(sessions.map(s => s.session), ['ok']);
  } finally {
    chmodSync(bad, 0o600); // let cleanup remove it
  }
});
