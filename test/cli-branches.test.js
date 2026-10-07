// Branch-coverage tests for src/cli.ts flag plumbing that test/cli.test.js and
// test/cli-error-paths.test.js leave unexercised: positional-text `send`, the
// pluk-send --session + positional-text split, the "stdin" default session and
// --patterns-dir in `watch`, the --pane target in capture mode, the live-tmux
// (green dot) sessions-table row, and PLUK_RUN_DIR as the subscribe run dir.
// Same harness style as test/cli.test.js: spawn dist/cli.js with stub tmux.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let scratch; // per-run temp root
let stubBin; // dir holding fake tmux (has-session fails => not alive)
let aliveBin; // dir holding fake tmux that reports live sessions
let tmuxLog; // file where the fake tmuxes record their argv

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pluk-cli-br-'));
  stubBin = join(scratch, 'bin');
  aliveBin = join(scratch, 'bin-alive');
  tmuxLog = join(scratch, 'tmux-args.log');
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(aliveBin, { recursive: true });

  // Fake tmux: records argv lines; knows no sessions.
  writeFileSync(
    join(stubBin, 'tmux'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${tmuxLog}'
[ "$1" = "has-session" ] && exit 1
[ "$1" = "list-sessions" ] && exit 1
exit 0
`,
  );
  // Fake tmux that reports agent-live as a running session and serves frames.
  writeFileSync(
    join(aliveBin, 'tmux'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${tmuxLog}'
[ "$1" = "list-sessions" ] && { echo agent-live; exit 0; }
[ "$1" = "capture-pane" ] && { echo 'esc to interrupt'; exit 0; }
exit 0
`,
  );
  for (const f of [join(stubBin, 'tmux'), join(aliveBin, 'tmux')]) {
    chmodSync(f, 0o755);
  }
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCli(args, { argv1 = CLI, env = {}, bin = stubBin, input } = {}) {
  const res = spawnSync(process.execPath, [argv1, ...args], {
    encoding: 'utf-8',
    input,
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TERM_PROGRAM: '',
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

// --- send: positional text ------------------------------------------------------

test('send joins positional words as the text when --text is absent', () => {
  rmSync(tmuxLog, { force: true });
  const { code } = runCli(['send', 'my-agent', 'hello', 'there']);
  assert.equal(code, 0);
  const calls = readFileSync(tmuxLog, 'utf-8').trim().split('\n');
  // No --enter and no --literal: bare send-keys, no -l, and no Enter keypress.
  assert.deepEqual(calls, ['send-keys -t =my-agent: -- hello there']);
});

test('pluk-send --session takes all positional args as text', () => {
  const link = join(scratch, 'pluk-send');
  try { symlinkSync(CLI, link); } catch {}
  rmSync(tmuxLog, { force: true });
  const { code } = runCli(['--session=agent-q', 'ping', 'pong'], { argv1: link });
  assert.equal(code, 0);
  const calls = readFileSync(tmuxLog, 'utf-8').trim().split('\n');
  assert.deepEqual(calls, ['send-keys -t =agent-q: -- ping pong']);
});

// --- watch: default session, --patterns-dir ------------------------------------

test('watch without a session labels events "stdin" and honors --patterns-dir', () => {
  const patternsDir = join(scratch, 'patterns');
  mkdirSync(patternsDir, { recursive: true });
  writeFileSync(
    join(patternsDir, 'testcli.patterns'),
    "WORKING_PATTERNS='CUSTOM_BUSY_MARKER'\n",
  );
  const { code, stdout } = runCli(
    ['watch', '--cli=testcli', `--patterns-dir=${patternsDir}`],
    { input: 'CUSTOM_BUSY_MARKER\n' },
  );
  assert.equal(code, 0);
  const events = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.length >= 1, `expected events, got: ${stdout}`);
  for (const ev of events) {
    assert.equal(ev.session, 'stdin');
  }
  assert.ok(
    events.some(ev => ev.type === 'state_change' && ev.data.to === 'working'),
    `custom pattern should classify working, got: ${stdout}`,
  );
});

// --- watch: capture mode --pane target ------------------------------------------

test('watch --capture polls the pane named by --pane, not the session', async () => {
  rmSync(tmuxLog, { force: true });
  const child = spawn(
    process.execPath,
    [CLI, 'watch', 'cap-sess', '--cli=claude', '--capture=50', '--pane=%7'],
    { env: { ...process.env, PATH: `${aliveBin}:${process.env.PATH}`, TERM_PROGRAM: '' } },
  );
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no event seen; got: ${out}`)), 10000);
    child.stdout.on('data', () => {
      if (out.includes('"state_change"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  }).finally(() => child.kill('SIGINT'));
  const calls = readFileSync(tmuxLog, 'utf-8');
  assert.match(calls, /capture-pane -p -t %7/);
  assert.ok(!calls.includes('-t cap-sess'), `pane target must win: ${calls}`);
  const ev = JSON.parse(out.trim().split('\n')[0]);
  assert.equal(ev.session, 'cap-sess');
  assert.equal(ev.data.to, 'working');
});

// --- sessions: live tmux row (green dot + working state) -------------------------

test('sessions table marks a live tmux session with a filled dot and colors working state', () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'agent-live.jsonl'),
    [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'copilot' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { to: 'working' } }),
    ].join('\n') + '\n',
  );
  const { code, stdout } = runCli(['sessions', `--run-dir=${dir}`], { bin: aliveBin });
  assert.equal(code, 0);
  assert.match(stdout, /agent-live\s+copilot\s+.*working/);
  assert.ok(stdout.includes('\u25CF'), `expected live dot ●, got: ${stdout}`);
  assert.ok(stdout.includes('\x1b[32m\u25CF'), `working rows use the green live dot: ${stdout}`);
});

// --- subscribe: PLUK_RUN_DIR fallback --------------------------------------------

test('subscribe resolves the run dir from PLUK_RUN_DIR when --run-dir is absent', async () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'env-sub.jsonl'),
    eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'idle' } }) + '\n',
  );
  const child = spawn(
    process.execPath,
    [CLI, 'subscribe', 'env-sub', '--from-beginning'],
    {
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        PLUK_RUN_DIR: dir,
        TERM_PROGRAM: '',
      },
    },
  );
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no event seen; got: ${out}`)), 10000);
    child.stdout.on('data', () => {
      if (out.includes('"type":"state_change"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  }).finally(() => child.kill('SIGINT'));
  const ev = JSON.parse(out.trim().split('\n')[0]);
  assert.equal(ev.type, 'state_change');
  assert.equal(ev.data.to, 'idle');
});
