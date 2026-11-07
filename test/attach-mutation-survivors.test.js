// Pins behaviour in src/attach.ts that the nightly mutation report showed as
// unasserted (attach.ts 78.12%, 93 survivors). Each test here fails on a
// specific surviving mutant that changes observable behaviour:
//   - resolveCliCommand / resolveDangerousFlag entries for copilot, codex,
//     omp and bob (an emptied map entry survived)
//   - the ensurePrivateLogFile(logFile) call (deleting it survived: nothing
//     asserted the transcript's existence or mode after attach)
//   - appleScriptString backslash escaping and the which-resolved tmux path
//     in the osascript attach command
//   - --no-open under --rationguard (the gate inverted to `true` survived)
//   - exact watcher argv without --rebuttal/--verbose (the `: []` arms)
//   - the reap skipping pluk's own PID when pgrep reports it
//   - the pluk-classify fallback name in resolvePlukBin
//   - attach() rejecting workDir: '' and defaulting verbose to off (both
//     only reachable via a direct call: cli.js rejects --dir= centrally and
//     always passes a boolean verbose)
//   - the verbose-only diagnostics that gate on rgBin / plukBin
//   - --dangerous on an existing session with a CLI that has no auto-flag
//   - SIGINT exiting promptly and reaping the watcher
// Child-process tests reuse the stub-bin PATH pattern from
// attach-orchestration.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const ATTACH = join(process.cwd(), 'dist', 'attach.js');
const scratch = mkdtempSync(join(tmpdir(), 'pluk-attach-mut-'));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeStub(dir, name, script) {
  const file = join(dir, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

// Every stub appends its argv to <name>.log so tests can assert on exactly
// what attach() executed. `dirName` lets a test choose a hostile stub-dir name.
function makeStubs({
  hasSession = false,
  which = ['tmux'],
  npxOk = false,
  pgrepPids = '',
  dirName = '',
  rgPidFile = '',
} = {}) {
  let dir;
  if (dirName) {
    dir = join(scratch, dirName);
    mkdirSync(dir);
  } else {
    dir = mkdtempSync(join(scratch, 'stub-'));
  }
  const logFor = name => join(dir, `${name}.log`);

  writeStub(dir, 'tmux', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('tmux')}'
[ "$1" = "has-session" ] && exit ${hasSession ? 0 : 1}
exit 0
`);
  writeStub(dir, 'which', `#!/bin/sh
case "$1" in
  ${which.join('|') || 'nothing-resolves'}) echo '${dir}'/"$1"; exit 0 ;;
  *) exit 1 ;;
esac
`);
  writeStub(dir, 'npx', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('npx')}'
exit ${npxOk ? 0 : 1}
`);
  // $PPID is the attach process itself: pgrep is run from it via execFileSync.
  writeStub(dir, 'pgrep', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('pgrep')}'
${pgrepPids ? `printf '%s\\n' "${pgrepPids}"\nexit 0` : 'exit 1'}
`);
  writeStub(dir, 'kill', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('kill')}'
exit 0
`);
  writeStub(dir, 'osascript', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('osascript')}'
exit 0
`);
  writeStub(dir, 'pluk', '#!/bin/sh\nexit 0\n');
  writeStub(dir, 'pluk-classify', '#!/bin/sh\nexit 0\n');
  writeStub(dir, 'rationguard', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('rationguard')}'
${rgPidFile ? `echo $$ > '${rgPidFile}'\nexec sleep 10` : 'exit 0'}
`);

  return {
    dir,
    log: name => {
      try { return readFileSync(logFor(name), 'utf-8'); } catch { return ''; }
    },
  };
}

function runAttach(args, stubs, env = {}) {
  const res = spawnSync(process.execPath, [CLI, 'attach', ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${stubs.dir}:${process.env.PATH}`,
      TERM_PROGRAM: '',
      ...env,
    },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeRunDir() {
  return mkdtempSync(join(scratch, 'run-'));
}

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

// --- CLI command and auto-approve flag table --------------------------------------

test('attach --dangerous maps copilot, codex, omp and bob to their own command and auto-approve flag', () => {
  const cases = [
    ['copilot', "'copilot' '--allow-all-tools'"],
    ['codex', "'codex' '--full-auto'"],
    ['omp', "'omp' '--approval-mode' 'yolo'"],
    ['bob', "'bob' '--approval-mode' 'yolo'"],
  ];
  for (const [cli, expected] of cases) {
    const stubs = makeStubs({ which: ['tmux', 'pluk'] });
    const { code, stderr } = runAttach(
      [`agent-${cli}`, `--cli=${cli}`, `--run-dir=${makeRunDir()}`, '--no-open', '--dangerous'],
      stubs,
    );
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /no known auto-approve flag/);
    const sendKeys = stubs.log('tmux').split('\n').find(l => l.startsWith('send-keys'));
    assert.equal(sendKeys, `send-keys -t =agent-${cli}: -- ${expected} Enter`);
  }
});

test('attach to an existing session with --dangerous and an unmapped CLI prints no restart hint', () => {
  const stubs = makeStubs({ hasSession: true, which: ['tmux', 'pluk'] });
  const { code, stderr } = runAttach(
    ['agent-x', '--cli=nosuchcli', `--run-dir=${makeRunDir()}`, '--no-open', '--dangerous'],
    stubs,
  );
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /session already exists\. The CLI may not have/);
  assert.doesNotMatch(stderr, /To restart with permissions skipped/);
});

// --- run dir and log file hardening -----------------------------------------------

test('attach repairs a world-readable run dir and log file to 0700/0600', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const runDir = join(makeRunDir(), 'run');
  const logsDir = join(runDir, 'logs');
  const logFile = join(logsDir, 'agent-perm.jsonl');
  mkdirSync(logsDir, { recursive: true, mode: 0o755 });
  chmodSync(runDir, 0o755);
  chmodSync(logsDir, 0o755);
  writeFileSync(logFile, '');
  chmodSync(logFile, 0o644);

  const { code, stderr } = runAttach(['agent-perm', `--run-dir=${runDir}`, '--no-open'], stubs);
  assert.equal(code, 0, stderr);
  assert.equal(modeOf(runDir), 0o700, 'run dir must be made private');
  assert.equal(modeOf(logsDir), 0o700, 'logs dir must be made private');
  assert.equal(modeOf(logFile), 0o600, 'log file must be made private');
});

test('attach creates the transcript under <run-dir>/logs with mode 0600 before tmux writes to it', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const runDir = join(makeRunDir(), 'fresh');
  const logFile = join(runDir, 'logs', 'agent-new.jsonl');

  const { code, stderr } = runAttach(['agent-new', `--run-dir=${runDir}`, '--no-open'], stubs);
  assert.equal(code, 0, stderr);
  assert.ok(existsSync(logFile), `transcript not pre-created: ${logFile}`);
  assert.equal(modeOf(logFile), 0o600);
  assert.equal(modeOf(join(runDir, 'logs')), 0o700);
  assert.equal(modeOf(runDir), 0o700);
  assert.match(stubs.log('tmux'), new RegExp(`^pipe-pane .*${logFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
});

// --- resolvePlukBin -----------------------------------------------------------------

test('resolvePlukBin falls back to pluk-classify when pluk is not on PATH', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk-classify'] });
  const { code, stderr } = runAttach(['agent-pc', `--run-dir=${makeRunDir()}`, '--no-open'], stubs);
  assert.equal(code, 0, stderr);
  const pipe = stubs.log('tmux').split('\n').find(l => l.startsWith('pipe-pane'));
  assert.ok(pipe, `no pipe-pane call: ${stubs.log('tmux')}`);
  assert.ok(pipe.includes(`${stubs.dir}/pluk-classify`), pipe);
  assert.equal(stubs.log('npx'), '', 'npx must not be probed when pluk-classify resolves');
});

// --- verbose diagnostics -------------------------------------------------------------

test('attach without --verbose emits none of the verbose-only diagnostics', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stderr } = runAttach(['agent-quiet', `--run-dir=${makeRunDir()}`, '--no-open'], stubs);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /^\[pluk\] session=agent-quiet /m);
  assert.doesNotMatch(stderr, /Securing run directory/);
  assert.doesNotMatch(stderr, /pluk binary:/);
});

test('attach --verbose reports the pluk binary, the run dir and only a resolved rationguard binary', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const runDir = makeRunDir();
  const { code, stderr } = runAttach(['agent-v', `--run-dir=${runDir}`, '--no-open', '--verbose'], stubs);
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`^\\[pluk\\] session=agent-v cli=claude runDir=${runDir} workDir=`, 'm'));
  assert.match(stderr, new RegExp(`^\\[pluk\\] pluk binary: '${stubs.dir}/pluk'$`, 'm'));
  assert.match(stderr, new RegExp(`^\\[pluk\\] Securing run directory: ${runDir}$`, 'm'));
  assert.doesNotMatch(stderr, /rationguard binary:/);

  const rg = makeStubs({ which: ['tmux', 'rationguard'] });
  const res = runAttach(
    ['agent-v2', `--run-dir=${makeRunDir()}`, '--no-open', '--verbose', '--rationguard'],
    rg,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, new RegExp(`^\\[pluk\\] rationguard binary: '${rg.dir}/rationguard'$`, 'm'));
  assert.match(res.stderr, /^\[pluk\] pluk binary: \(not found\)$/m);
  assert.match(res.stderr, /^\[pluk\] skipping terminal window \(--no-open\)$/m);
});

// --- --rationguard orchestration -----------------------------------------------------

test('--rationguard --no-open neither opens a window nor prints the attach hint', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'] });
  const { code, stderr } = runAttach(
    ['agent-rn', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard'],
    stubs,
    { TERM_PROGRAM: 'iTerm.app' },
  );
  assert.equal(code, 0, stderr);
  assert.equal(stubs.log('osascript'), '', 'no terminal window may be opened with --no-open');
  assert.doesNotMatch(stderr, /To interact with the agent: tmux attach/);
  assert.doesNotMatch(stderr, /Opened iTerm2 window/);
});

test('--rationguard without --rebuttal/--verbose spawns the watcher with exactly four arguments', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'] });
  const runDir = makeRunDir();
  const { code, stderr } = runAttach(
    ['agent-exact', '--cli=codex', `--run-dir=${runDir}`, '--no-open', '--rationguard'],
    stubs,
  );
  assert.equal(code, 0, stderr);
  assert.equal(stubs.log('rationguard').trim(), `watch agent-exact --run-dir=${runDir} --cli=codex`);
});

test('--rationguard never kills the attaching pluk process when pgrep reports its own PID', () => {
  // The pgrep stub echoes $PPID, which is the attach process, alongside a stale watcher.
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'], pgrepPids: '$PPID\n4242' });
  const { code, stderr } = runAttach(
    ['agent-self', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard', '--verbose'],
    stubs,
  );
  assert.equal(code, 0, stderr);
  assert.equal(stubs.log('kill').trim(), '4242');
  assert.match(stderr, /^\[pluk\] killing 1 existing rationguard watcher\(s\) for agent-self: 4242$/m);
});

test('iTerm2 attach command carries the which-resolved tmux path with backslashes escaped for AppleScript', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'], dirName: 'back\\slash' });
  const { code, stderr } = runAttach(
    ['agent-bs', `--run-dir=${makeRunDir()}`, '--rationguard'],
    stubs,
    { TERM_PROGRAM: 'iTerm.app' },
  );
  assert.equal(code, 0, stderr);
  const call = stubs.log('osascript');
  assert.match(call, /^-e tell application "iTerm2" to create window with default profile command "/);
  // shellQuote wraps the path in single quotes; appleScriptString then doubles the backslash.
  assert.ok(call.includes(`'${scratch}/back\\\\slash/tmux' attach -t`), call);
  assert.ok(!call.includes('back\\slash/tmux'), `backslash left unescaped: ${call}`);
});

test('SIGINT while the rationguard watcher runs exits promptly and reaps the watcher', async () => {
  const rgPidFile = join(scratch, `rg-${process.pid}.pid`);
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'], rgPidFile });
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [CLI, 'attach', 'agent-sig', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard'],
    { env: { ...process.env, PATH: `${stubs.dir}:${process.env.PATH}`, TERM_PROGRAM: '' } },
  );
  let out = '';
  child.stderr.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`watcher never started; got: ${out}`)), 10000);
    const poll = setInterval(() => {
      if (existsSync(rgPidFile)) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 20);
  });
  const watcherPid = Number(readFileSync(rgPidFile, 'utf-8').trim());
  assert.ok(watcherPid > 0, 'watcher pid not recorded');

  const exitCode = await new Promise(resolve => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.on('exit', code => resolve(code));
    child.kill('SIGINT');
  });
  const elapsed = Date.now() - started;
  assert.equal(exitCode, 0);
  // The stub sleeps for 10s: a handler that waits for the watcher instead of
  // killing it would only return once the sleep ends.
  assert.ok(elapsed < 5000, `attach took ${elapsed}ms to exit on SIGINT`);

  const watcherGone = () => {
    try {
      return /^State:\s+Z/m.test(readFileSync(`/proc/${watcherPid}/status`, 'utf-8'));
    } catch {
      return true;
    }
  };
  const deadline = Date.now() + 3000;
  while (!watcherGone() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(watcherGone(), `watcher ${watcherPid} still running after SIGINT`);
});

// --- direct attach() call ------------------------------------------------------------

test('attach() rejects workDir: "" before any tmux call', () => {
  // cli.js rejects --dir= centrally, so the attach() guard is only reachable directly.
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const script = `import { attach } from ${JSON.stringify(ATTACH)};
attach({ session: 'agent-nodir', runDir: ${JSON.stringify(makeRunDir())}, noOpen: true, workDir: '' });`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, PATH: `${stubs.dir}:${process.env.PATH}` },
  });
  assert.notEqual(res.status, 0, 'attach() must throw for an empty workDir');
  assert.match(res.stderr, /--dir requires a non-empty path/);
  assert.equal(stubs.log('tmux'), '', 'validation must precede all tmux calls');
});

test('attach() without a verbose option emits no verbose-only diagnostics', () => {
  // cli.js always passes verbose as a boolean, so the option-level default is
  // only reachable through a direct attach() call.
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const script = `import { attach } from ${JSON.stringify(ATTACH)};
attach({ session: 'agent-defv', runDir: ${JSON.stringify(makeRunDir())}, noOpen: true });`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, PATH: `${stubs.dir}:${process.env.PATH}` },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /Starting claude: 'claude'/);
  assert.doesNotMatch(res.stderr, /^\[pluk\] /m);
});
