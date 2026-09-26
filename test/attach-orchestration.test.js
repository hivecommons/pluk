// Orchestration tests for src/attach.ts — the branches cli.test.js's single
// happy-path attach run never reaches (previously 56.6% line coverage):
//   - existing-session path, incl. the --dangerous "already exists" warning
//   - --dangerous with a CLI that has no known auto-flag
//   - pluk binary resolution: npx fallback (hit and miss)
//   - rationguard branch: pgrep/kill of stale watchers, watcher spawn args,
//     SIGINT forwarding to the spawned watcher
//   - openTmuxInNewWindow: iTerm2/Terminal osascript paths (+ AppleScript
//     string escaping) and the plain-hint fallback
//   - final `tmux attach` (success and detached-session catch)
//   - splitShellWords backslash escaping
// Each test spawns dist/cli.js with a per-test stub-bin directory on PATH,
// the same pattern cli.test.js uses.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitShellWords } from '../dist/attach.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const scratch = mkdtempSync(join(tmpdir(), 'pluk-attach-'));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeStub(dir, name, script) {
  const file = join(dir, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

// Builds a fresh stub-bin dir. Every stub appends its argv to <name>.log so
// tests can assert on exactly what attach() executed.
function makeStubs({
  hasSession = false,   // fake tmux `has-session` result
  which = ['tmux'],     // names the fake `which` resolves (to their stubs)
  npxOk = false,        // fake npx exit status (pluk npx fallback probe)
  pgrepPids = '',       // fake pgrep stdout ('' => exit 1, "no watchers")
  osascriptOk = true,   // fake osascript exit status
  tmuxAttachOk = true,  // fake tmux `attach` result
  rgSleep = 0,          // seconds the fake rationguard stays alive
} = {}) {
  const dir = mkdtempSync(join(scratch, 'stub-'));
  const logFor = name => join(dir, `${name}.log`);

  writeStub(dir, 'tmux', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('tmux')}'
[ "$1" = "has-session" ] && exit ${hasSession ? 0 : 1}
[ "$1" = "attach" ] && exit ${tmuxAttachOk ? 0 : 1}
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
  writeStub(dir, 'pgrep', pgrepPids
    ? `#!/bin/sh\nprintf '%s\\n' '${pgrepPids}'\nexit 0\n`
    : '#!/bin/sh\nexit 1\n');
  writeStub(dir, 'kill', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('kill')}'
exit 0
`);
  writeStub(dir, 'osascript', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('osascript')}'
exit ${osascriptOk ? 0 : 1}
`);
  writeStub(dir, 'pluk', '#!/bin/sh\nexit 0\n');
  writeStub(dir, 'rationguard', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('rationguard')}'
sleep ${rgSleep}
exit 0
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

// --- existing-session path ---------------------------------------------------------

test('attach to an existing session skips create/send-keys and warns about --dangerous', () => {
  const stubs = makeStubs({ hasSession: true, which: ['tmux', 'pluk'] });
  const { code, stdout } = runAttach(
    ['agent-e', '--cli=claude', `--run-dir=${makeRunDir()}`, '--no-open', '--dangerous'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /Attaching to existing tmux session: agent-e/);
  assert.match(stdout, /--dangerous was set but session already exists/);
  assert.match(stdout, /--dangerously-skip-permissions/);
  const tmuxCalls = stubs.log('tmux');
  assert.ok(!tmuxCalls.includes('new-session'), `unexpected create: ${tmuxCalls}`);
  assert.ok(!tmuxCalls.includes('send-keys'), `unexpected send-keys: ${tmuxCalls}`);
});

test('attach --dangerous with a CLI that has no auto-flag logs the skip and sends the bare command', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stdout } = runAttach(
    ['agent-a', '--cli=aider', `--run-dir=${makeRunDir()}`, '--no-open', '--dangerous', '--verbose'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /no dangerous\/auto flag known for cli=aider/);
  assert.match(stubs.log('tmux'), /send-keys -t agent-a 'aider' Enter/);
});

// --- pluk binary resolution --------------------------------------------------------

test('when pluk is not on PATH the npx fallback is probed and used for pipe-pane', () => {
  const stubs = makeStubs({ which: ['tmux'], npxOk: true });
  const { code, stdout } = runAttach(
    ['agent-n', `--run-dir=${makeRunDir()}`, '--no-open', '--no-raw'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /Attaching pluk pipe-pane/);
  assert.match(stubs.log('npx'), /--yes @hivecommons\/pluk version/);
  const pipeCall = stubs.log('tmux').split('\n').find(l => l.startsWith('pipe-pane'));
  assert.ok(pipeCall.includes("'npx' '--yes' '@hivecommons/pluk' watch 'agent-n'"), pipeCall);
  assert.ok(!pipeCall.includes('--include-raw'), `--no-raw ignored: ${pipeCall}`);
});

test('when pluk and the npx fallback are both unavailable, pipe-pane is skipped with a warning', () => {
  const stubs = makeStubs({ which: ['tmux'], npxOk: false });
  const { code, stdout } = runAttach(
    ['agent-m', `--run-dir=${makeRunDir()}`, '--no-open'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /pluk binary not found, skipping pipe-pane/);
  assert.match(stdout, /npm install -g @hivecommons\/pluk/);
  assert.ok(!stubs.log('tmux').includes('pipe-pane'), 'pipe-pane should not run');
});

// --- rationguard branch ------------------------------------------------------------

test('--rationguard kills stale watchers and spawns rationguard with rebuttal/verbose flags', () => {
  const stubs = makeStubs({
    which: ['tmux', 'pluk', 'rationguard'],
    pgrepPids: '11111\n22222',
  });
  const runDir = makeRunDir();
  const { code, stdout } = runAttach(
    ['agent-r', '--cli=claude', `--run-dir=${runDir}`, '--no-open',
     '--rationguard', '--rebuttal=log', '--verbose'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /killing 2 existing rationguard watcher\(s\) for agent-r/);
  assert.equal(stubs.log('kill').trim(), '11111 22222');
  assert.match(stdout, /Starting rationguard watcher in this terminal/);
  assert.equal(
    stubs.log('rationguard').trim(),
    `watch agent-r --run-dir=${runDir} --cli=claude --rebuttal=log --verbose`,
  );
});

test('--rationguard without --no-open on a non-mac terminal prints the plain attach hint', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'] });
  const { code, stdout } = runAttach(
    ['agent-u', `--run-dir=${makeRunDir()}`, '--rationguard'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /To interact with the agent: tmux attach -t agent-u/);
  assert.equal(stubs.log('osascript'), '', 'osascript must not run off-mac');
});

test('SIGINT while the rationguard watcher runs kills it and exits 0', async () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'], rgSleep: 10 });
  const child = spawn(
    process.execPath,
    [CLI, 'attach', 'agent-s', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard'],
    {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${stubs.dir}:${process.env.PATH}`, TERM_PROGRAM: '' },
    },
  );
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`watcher never started; got: ${out}`)), 10000);
    child.stdout.on('data', () => {
      if (out.includes('Ctrl+C to stop')) {
        clearTimeout(timer);
        // Give the sleep-based stub a moment to be spawned before interrupting.
        setTimeout(resolve, 200);
      }
    });
  });
  const exitCode = await new Promise(resolve => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.on('exit', code => resolve(code));
    child.kill('SIGINT');
  });
  assert.equal(exitCode, 0);
});

// --- openTmuxInNewWindow (osascript) -------------------------------------------------

test('iTerm2 window is opened via osascript with the attach command quoted for AppleScript', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'] });
  const { code, stdout } = runAttach(
    ['agent-i', `--run-dir=${makeRunDir()}`, '--rationguard'],
    stubs,
    { TERM_PROGRAM: 'iTerm.app' },
  );
  assert.equal(code, 0);
  assert.match(stdout, /Opened iTerm2 window attached to tmux session: agent-i/);
  const call = stubs.log('osascript');
  assert.match(call, /tell application "iTerm2" to create window/);
  // appleScriptString must escape the double quotes around the shell-quoted command
  assert.ok(call.includes(`attach -t 'agent-i'`), call);
});

test('Apple_Terminal window is opened via osascript do script', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'] });
  const { code, stdout } = runAttach(
    ['agent-t', `--run-dir=${makeRunDir()}`, '--rationguard'],
    stubs,
    { TERM_PROGRAM: 'Apple_Terminal' },
  );
  assert.equal(code, 0);
  assert.match(stdout, /Opened Terminal window attached to tmux session: agent-t/);
  assert.match(stubs.log('osascript'), /tell application "Terminal" to do script/);
});

test('osascript failure falls back to the plain attach hint', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'], osascriptOk: false });
  const { code, stdout } = runAttach(
    ['agent-f', `--run-dir=${makeRunDir()}`, '--rationguard'],
    stubs,
    { TERM_PROGRAM: 'iTerm.app' },
  );
  assert.equal(code, 0);
  assert.ok(!stdout.includes('Opened iTerm2 window'), stdout);
  assert.match(stdout, /To interact with the agent: tmux attach -t agent-f/);
});

// --- final tmux attach -------------------------------------------------------------

test('without --no-open and without rationguard, attach execs tmux attach', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stdout } = runAttach(
    ['agent-o', `--run-dir=${makeRunDir()}`],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /Attaching to tmux session\.\.\./);
  assert.match(stubs.log('tmux'), /^attach -t agent-o$/m);
  assert.ok(!stdout.includes('Session detached'), stdout);
});

test('a failing tmux attach is caught and prints the reattach hint', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'], tmuxAttachOk: false });
  const { code, stdout } = runAttach(
    ['agent-d', `--run-dir=${makeRunDir()}`],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /Session detached\. To reattach: tmux attach -t agent-d/);
});

// --- splitShellWords escaping ------------------------------------------------------

test('splitShellWords honors backslash escapes outside single quotes', () => {
  assert.deepEqual(splitShellWords('a\\ b c'), ['a b', 'c']);
  assert.deepEqual(splitShellWords('"a\\"b"'), ['a"b']);
  assert.deepEqual(splitShellWords("'a\\b'"), ['a\\b']);
  // trailing backslash is preserved literally
  assert.deepEqual(splitShellWords('x\\'), ['x\\']);
});
