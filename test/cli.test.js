// End-to-end tests for src/cli.ts — the bin dispatch layer (previously 0% covered).
// Each test spawns dist/cli.js as a subprocess, the same way npm bin stubs invoke it.
// A stub `tmux` (and `which`/`pgrep`) directory is prepended to PATH so commands
// that shell out to tmux are exercised without a real tmux server.
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
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

let scratch; // per-run temp root
let stubBin; // dir holding fake tmux/which/pgrep
let tmuxLog; // file where the fake tmux records its argv

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pluk-cli-'));
  stubBin = join(scratch, 'bin');
  tmuxLog = join(scratch, 'tmux-args.log');
  mkdirSync(stubBin, { recursive: true });

  // Fake tmux: records argv lines; `has-session` fails so attach takes the
  // create-session path; everything else succeeds.
  writeFileSync(
    join(stubBin, 'tmux'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${tmuxLog}'
[ "$1" = "has-session" ] && exit 1
exit 0
`,
  );
  // Fake which: resolves only tmux and pluk to our stubs, fails otherwise
  // (so resolveRationguardBin falls back without probing npx).
  writeFileSync(
    join(stubBin, 'which'),
    `#!/bin/sh
case "$1" in
  tmux|pluk) echo '${stubBin}'/"$1"; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  writeFileSync(join(stubBin, 'pluk'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(stubBin, 'pgrep'), '#!/bin/sh\nexit 1\n');
  for (const f of ['tmux', 'which', 'pluk', 'pgrep']) {
    chmodSync(join(stubBin, f), 0o755);
  }
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

// --- version / help / dispatch ------------------------------------------------

test('version prints the package version from package.json', () => {
  const { code, stdout } = runCli(['version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), `@hivecommons/pluk ${pkg.version}`);
});

test('no arguments prints usage and exits 0', () => {
  const { code, stdout } = runCli([]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /pluk attach <session>/);
});

test('--help and -h print usage and exit 0', () => {
  for (const flag of ['--help', '-h']) {
    const { code, stdout } = runCli([flag]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage:/);
  }
});

test('an unknown command prints an error plus usage and exits 1', () => {
  const { code, stdout, stderr } = runCli(['frobnicate']);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command:.*frobnicate/s);
  assert.match(stdout, /Usage:/);
});

// --- patterns ------------------------------------------------------------------

test('patterns lists every pattern field for the chosen CLI', () => {
  const { code, stdout } = runCli(['patterns', '--cli=claude']);
  assert.equal(code, 0);
  assert.match(stdout, /Patterns for claude:/);
  for (const field of ['idle', 'working', 'rateLimit', 'login', 'trustDialog',
    'bypass', 'toolStart', 'toolEnd', 'error', 'model', 'sessionEnd']) {
    assert.match(stdout, new RegExp(`^  ${field}\\b`, 'm'), `missing field ${field}`);
  }
  assert.match(stdout, /Available CLIs: .*claude/);
});

// --- sessions ------------------------------------------------------------------

test('sessions --json prints [] for an empty run dir', () => {
  const dir = makeRunDir();
  const { code, stdout } = runCli(['sessions', `--run-dir=${dir}`, '--json']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), []);
});

test('sessions prints a friendly message when nothing is found', () => {
  const dir = makeRunDir();
  const { code, stdout } = runCli(['sessions', `--run-dir=${dir}`]);
  assert.equal(code, 0);
  assert.match(stdout, /No active pluk sessions found\./);
});

test('sessions renders a table row per discovered session (ls alias)', () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'agent-a.jsonl'),
    [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'claude' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { to: 'idle' } }),
    ].join('\n') + '\n',
  );
  const { code, stdout } = runCli(['ls', `--run-dir=${dir}`]);
  assert.equal(code, 0);
  assert.match(stdout, /SESSION\s+CLI\s+STATE\s+TMUX\s+LAST ACTIVITY.*EVENTS/);
  assert.match(stdout, /agent-a\s+claude\s+.*idle/);
});

// --- send ----------------------------------------------------------------------

test('send without a session exits 1 with guidance', () => {
  const { code, stderr } = runCli(['send']);
  assert.equal(code, 1);
  assert.match(stderr, /session name is required/);
});

test('send without text exits 1 with guidance', () => {
  const { code, stderr } = runCli(['send', 'my-agent']);
  assert.equal(code, 1);
  assert.match(stderr, /text is required/);
});

test('send --text --enter issues a literal send-keys plus a separate Enter key', () => {
  rmSync(tmuxLog, { force: true });
  const { code } = runCli(['send', 'my-agent', '--text=hello world', '--enter']);
  assert.equal(code, 0);
  const calls = readFileSync(tmuxLog, 'utf-8').trim().split('\n');
  assert.deepEqual(calls, [
    'send-keys -l -t my-agent hello world',
    'send-keys -t my-agent Enter',
  ]);
});

test('send reports a tmux failure and exits 1', () => {
  const { code, stderr } = runCli(['send', 'my-agent', '--text=hi'], {
    env: { PATH: '/nonexistent-dir' }, // no tmux anywhere
  });
  assert.equal(code, 1);
  assert.match(stderr, /failed to send to session "my-agent"/);
});

// --- subscribe / attach argument validation -------------------------------------

test('subscribe without a session exits 1 with guidance', () => {
  const { code, stderr } = runCli(['subscribe']);
  assert.equal(code, 1);
  assert.match(stderr, /session name is required/);
});

test('attach without a session exits 1 with guidance', () => {
  const { code, stderr } = runCli(['attach']);
  assert.equal(code, 1);
  assert.match(stderr, /session name is required/);
});

test('attach rejects unsafe session names before touching tmux', () => {
  rmSync(tmuxLog, { force: true });
  const { code, stdout, stderr } = runCli(['attach', 'bad;name']);
  assert.equal(code, 1);
  assert.match(stderr, /Unsafe session name/);
  assert.doesNotMatch(stdout, /Creating tmux session/);
  assert.throws(() => readFileSync(tmuxLog), /ENOENT/, 'tmux must not be invoked');
});

// --- attach happy path (stubbed tmux) --------------------------------------------

test('attach --no-open creates the session, starts the CLI, and wires pipe-pane', () => {
  rmSync(tmuxLog, { force: true });
  const runDir = makeRunDir();
  const { code, stdout } = runCli([
    'attach', 'agent-x', '--cli=claude', `--run-dir=${runDir}`, '--no-open', '--verbose',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /Creating tmux session: agent-x/);
  assert.match(stdout, /Starting claude: 'claude'/);
  assert.match(stdout, /Attaching pluk pipe-pane: claude/);
  assert.match(stdout, /Session ready\. To interact: tmux attach -t agent-x/);

  const calls = readFileSync(tmuxLog, 'utf-8');
  assert.match(calls, /^has-session -t agent-x$/m);
  assert.match(calls, /^new-session -d -s agent-x -c /m);
  assert.match(calls, /^send-keys -t agent-x 'claude' Enter$/m);
  assert.match(calls, /^pipe-pane -t agent-x -o PLUK_RUN_DIR=/m);
});

test('attach --dangerous appends the per-CLI danger flag to the start command', () => {
  rmSync(tmuxLog, { force: true });
  const runDir = makeRunDir();
  const { code, stdout } = runCli([
    'attach', 'agent-y', '--cli=claude', `--run-dir=${runDir}`, '--no-open', '--dangerous',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /--dangerously-skip-permissions/);
  const calls = readFileSync(tmuxLog, 'utf-8');
  assert.match(calls, /^send-keys -t agent-y 'claude' '--dangerously-skip-permissions' Enter$/m);
});

// --- watch over stdin -------------------------------------------------------------

test('watch classifies stdin lines and emits JSONL events', () => {
  const { code, stdout } = runCli(
    ['watch', 'stdin-e2e', '--cli=claude', '--include-raw'],
    { input: 'esc to interrupt\n' },
  );
  assert.equal(code, 0);
  const events = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.length >= 1, `expected events, got: ${stdout}`);
  for (const ev of events) {
    assert.equal(ev.session, 'stdin-e2e');
    assert.equal(ev.v, 1);
  }
  assert.ok(events.some(ev => ev.type === 'raw_output'), 'raw_output expected with --include-raw');
});

test('watch --filter drops events outside the filter', () => {
  const { code, stdout } = runCli(
    ['watch', 's', '--cli=claude', '--include-raw', '--filter=rate_limit'],
    { input: 'plain line of output\n' },
  );
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '');
});

// --- bin-name dispatch (pluk-send / pluk-classify / pluk-subscribe) ---------------

test('pluk-send bin name dispatches straight to send', () => {
  const link = join(scratch, 'pluk-send');
  try { symlinkSync(CLI, link); } catch {}
  rmSync(tmuxLog, { force: true });
  const { code } = runCli(['--session=agent-z', '--text=hi', '--enter'], { argv1: link });
  assert.equal(code, 0);
  const calls = readFileSync(tmuxLog, 'utf-8').trim().split('\n');
  assert.deepEqual(calls, [
    'send-keys -l -t agent-z hi',
    'send-keys -t agent-z Enter',
  ]);
});

test('pluk-classify bin name dispatches straight to watch', () => {
  const link = join(scratch, 'pluk-classify');
  try { symlinkSync(CLI, link); } catch {}
  const { code, stdout } = runCli(
    ['stdin-bin', '--cli=claude', '--include-raw'],
    { argv1: link, input: 'hello\n' },
  );
  assert.equal(code, 0);
  assert.ok(stdout.includes('"session":"stdin-bin"'), `unexpected output: ${stdout}`);
});

test('pluk-subscribe bin name dispatches straight to subscribe (arg validation)', () => {
  const link = join(scratch, 'pluk-subscribe');
  try { symlinkSync(CLI, link); } catch {}
  const { code, stderr } = runCli([], { argv1: link });
  assert.equal(code, 1);
  assert.match(stderr, /session name is required/);
});

// --- subscribe end-to-end -----------------------------------------------------------

test('subscribe --from-beginning replays events from an existing log then is stopped', async () => {
  const dir = makeRunDir();
  writeFileSync(
    join(dir, 'logs', 'sub-e2e.jsonl'),
    eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'idle' } }) + '\n',
  );
  const child = spawn(
    process.execPath,
    [CLI, 'subscribe', 'sub-e2e', `--run-dir=${dir}`, '--from-beginning'],
    { env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` } },
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
  assert.equal(ev.session, 's');
});
