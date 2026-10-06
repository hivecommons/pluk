// Branch-gap tests for src/attach.ts — the arms attach-orchestration.test.js
// and cli.test.js still leave untaken (78.72% branch coverage):
//   - splitShellWords: trailing backslash, unterminated quote
//   - buildCliCommand: empty command throw, cliArgs merge
//   - buildPipePaneCommand: empty pluk command throw, includeRaw off
//   - resolveCliCommand fallback for a CLI with no known command mapping
//   - resolveRationguardBin fail-closed / override arms when `which rationguard` fails
//   - detectTerminal with TERM_PROGRAM absent from the environment
//   - resolveTmuxPath 'tmux' fallback when `which tmux` fails
//   - attach() cli default ('claude') when the option is omitted entirely —
//     cli.js always passes a cli, so only a direct call reaches this arm
//   - attach() with an explicit workDir (`--dir`)
// The darwin-only detectTerminal arm (process.platform === 'darwin' with no
// TERM_PROGRAM match) is unreachable on Linux CI and stays uncovered.
// Child-process tests reuse the stub-bin PATH pattern from
// attach-orchestration.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitShellWords, buildCliCommand, buildPipePaneCommand, resolveRationguardBin } from '../dist/attach.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const ATTACH = join(process.cwd(), 'dist', 'attach.js');
const scratch = mkdtempSync(join(tmpdir(), 'pluk-attach-gaps-'));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeStub(dir, name, script) {
  const file = join(dir, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

// Same stub layout as attach-orchestration.test.js: each stub appends its
// argv to <name>.log so tests can assert on what attach() executed.
function makeStubs({ which = ['tmux'] } = {}) {
  const dir = mkdtempSync(join(scratch, 'stub-'));
  const logFor = name => join(dir, `${name}.log`);

  writeStub(dir, 'tmux', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('tmux')}'
[ "$1" = "has-session" ] && exit 1
exit 0
`);
  writeStub(dir, 'which', `#!/bin/sh
case "$1" in
  ${which.join('|') || 'nothing-resolves'}) echo '${dir}'/"$1"; exit 0 ;;
  '${dir}'/*) echo "$1"; exit 0 ;;
  *) exit 1 ;;
esac
`);
  writeStub(dir, 'npx', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('npx')}'
exit 0
`);
  writeStub(dir, 'pgrep', '#!/bin/sh\nexit 1\n');
  writeStub(dir, 'pluk', '#!/bin/sh\nexit 0\n');
  writeStub(dir, 'rationguard', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('rationguard')}'
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
  const childEnv = {
    ...process.env,
    PATH: `${stubs.dir}:${process.env.PATH}`,
    TERM_PROGRAM: '',
    ...env,
  };
  // An explicit `undefined` value means "delete this variable".
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const res = spawnSync(process.execPath, [CLI, 'attach', ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: childEnv,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeRunDir() {
  return mkdtempSync(join(scratch, 'run-'));
}

// --- splitShellWords edge arms -------------------------------------------------------

test('splitShellWords preserves a trailing backslash as a literal', () => {
  assert.deepEqual(splitShellWords('foo\\'), ['foo\\']);
});

test('splitShellWords throws on an unterminated quote', () => {
  assert.throws(() => splitShellWords("claude 'unterminated"), /Unterminated quote/);
  assert.throws(() => splitShellWords('claude "unterminated'), /Unterminated quote/);
});

test('splitShellWords returns no words for blank input', () => {
  assert.deepEqual(splitShellWords(''), []);
  assert.deepEqual(splitShellWords('   '), []);
});

// --- buildCliCommand / buildPipePaneCommand throw arms -------------------------------

test('buildCliCommand rejects an empty command', () => {
  assert.throws(() => buildCliCommand(''), /CLI command cannot be empty/);
  assert.throws(() => buildCliCommand('   '), /CLI command cannot be empty/);
});

test('buildCliCommand merges cliArgs into the quoted command', () => {
  assert.equal(buildCliCommand('gh copilot', '--model gpt'), "'gh' 'copilot' '--model' 'gpt'");
  assert.equal(buildCliCommand('claude'), "'claude'");
});

test('buildPipePaneCommand rejects an empty pluk command', () => {
  assert.throws(
    () => buildPipePaneCommand({
      runDir: '/run', plukBin: '  ', session: 's', cli: 'claude',
      includeRaw: true, logFile: '/run/logs/s.jsonl',
    }),
    /pluk command cannot be empty/,
  );
});

test('buildPipePaneCommand omits --include-raw when includeRaw is false', () => {
  const cmd = buildPipePaneCommand({
    runDir: '/run', plukBin: 'pluk', session: 's', cli: 'claude',
    includeRaw: false, logFile: '/run/logs/s.jsonl',
  });
  assert.ok(!cmd.includes('--include-raw'), cmd);
  assert.ok(cmd.includes("watch 's'"), cmd);
});

// --- resolveCliCommand fallback ------------------------------------------------------

test('an unmapped --cli name is used verbatim as the command', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stdout } = runAttach(
    ['agent-fb', '--cli=somecli', `--run-dir=${makeRunDir()}`, '--no-open'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /Starting somecli: 'somecli'/);
  assert.match(stubs.log('tmux'), /send-keys -t =agent-fb -- 'somecli' Enter/);
});

// --- resolveRationguardBin: no implicit registry fetch ---------------------------------

test('attach --rationguard fails closed when rationguard is not on PATH (no npx fetch)', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stderr } = runAttach(
    ['agent-rg', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard'],
    stubs,
    { PLUK_RATIONGUARD_BIN: undefined },
  );
  assert.equal(code, 1);
  assert.match(stderr, /rationguard not found on PATH/);
  assert.match(stderr, /--rationguard-bin=/);
  assert.equal(stubs.log('npx'), '', 'npx must never be invoked for rationguard');
  // Resolved before any tmux side effect: no session was created.
  assert.equal(stubs.log('tmux'), '', 'tmux must not run when rationguard is missing');
});

test('--rationguard-bin runs the operator-chosen command verbatim', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'npx'] });
  const { code, stdout } = runAttach(
    ['agent-rgb', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard',
      '--rationguard-bin=npx --yes @hivecommons/rationguard@0.11.0'],
    stubs,
    { PLUK_RATIONGUARD_BIN: undefined },
  );
  assert.equal(code, 0);
  assert.match(stdout, /Starting rationguard watcher/);
  assert.match(stubs.log('npx'), /^--yes @hivecommons\/rationguard@0\.11\.0 watch agent-rgb /m);
});

test('a rationguard that cannot be spawned exits non-zero with a clear error', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', '/nonexistent/rg'] });
  const { code, stderr } = runAttach(
    ['agent-enoent', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard', '--rationguard-bin=/nonexistent/rg'],
    stubs,
    { PLUK_RATIONGUARD_BIN: undefined },
  );
  assert.equal(code, 1);
  assert.match(stderr, /Failed to start rationguard/);
});

test('the rationguard exit code is propagated', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  writeStub(stubs.dir, 'rationguard', '#!/bin/sh\nexit 3\n');
  const { code } = runAttach(
    ['agent-exit', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard', `--rationguard-bin=${stubs.dir}/rationguard`],
    stubs,
    { PLUK_RATIONGUARD_BIN: undefined },
  );
  assert.equal(code, 3);
});

test('PLUK_RATIONGUARD_BIN is honoured when rationguard is not on PATH', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stdout } = runAttach(
    ['agent-rge', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard'],
    stubs,
    { PLUK_RATIONGUARD_BIN: `${stubs.dir}/rationguard` },
  );
  assert.equal(code, 0);
  assert.match(stdout, /Starting rationguard watcher/);
  assert.match(stubs.log('rationguard'), /^watch agent-rge /m);
  assert.equal(stubs.log('npx'), '');
});

test('resolveRationguardBin prefers the explicit override over PATH and env', () => {
  assert.equal(resolveRationguardBin('/opt/rg', { PLUK_RATIONGUARD_BIN: '/env/rg' }, () => '/path/rg'), '/opt/rg');
  assert.equal(resolveRationguardBin(undefined, { PLUK_RATIONGUARD_BIN: '/env/rg' }, () => '/path/rg'), '/env/rg');
  assert.equal(resolveRationguardBin('  ', {}, () => '/path/rg'), '/path/rg');
  assert.throws(() => resolveRationguardBin(undefined, {}, () => ''), /rationguard not found on PATH/);
});

test('resolveRationguardBin validates an explicit override with the same lookup', () => {
  const seen = [];
  const lookup = c => { seen.push(c); return c[0] === 'npx' ? '/bin/npx' : ''; };
  assert.equal(resolveRationguardBin('npx --yes rationguard@1', {}, lookup), 'npx --yes rationguard@1');
  assert.deepEqual(seen, [['npx']]);
  assert.throws(() => resolveRationguardBin('/nope/rg', {}, lookup), /not found or not executable/);
  assert.throws(() => resolveRationguardBin(undefined, { PLUK_RATIONGUARD_BIN: 'missing-rg' }, lookup), /not found or not executable/);
});

test('attach --rationguard-bin with a missing binary fails before any tmux call', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stderr } = runAttach(
    ['agent-bad', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard', '--rationguard-bin=/nonexistent/rg'],
    stubs,
    { PLUK_RATIONGUARD_BIN: undefined },
  );
  assert.equal(code, 1);
  assert.match(stderr, /not found or not executable/);
  assert.equal(stubs.log('tmux'), '', 'tmux must not run when the override is invalid');
});

// --- detectTerminal / resolveTmuxPath fallbacks --------------------------------------

test('a missing TERM_PROGRAM yields the plain attach hint off-mac', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk', 'rationguard'] });
  const { code, stdout } = runAttach(
    ['agent-nt', `--run-dir=${makeRunDir()}`, '--rationguard'],
    stubs,
    { TERM_PROGRAM: undefined },
  );
  assert.equal(code, 0);
  assert.match(stdout, /To interact with the agent: tmux attach -t agent-nt/);
  assert.equal(stubs.log('osascript'), '', 'osascript must not run off-mac');
});

test('resolveTmuxPath falls back to a bare tmux when `which tmux` fails', () => {
  const stubs = makeStubs({ which: ['pluk', 'rationguard'] });
  const { code, stdout } = runAttach(
    ['agent-wt', `--run-dir=${makeRunDir()}`, '--rationguard'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /To interact with the agent: tmux attach -t agent-wt/);
});

// --- attach() option defaults --------------------------------------------------------

test('attach() defaults the cli to claude when the option is omitted', () => {
  // cli.js always passes a cli (flags.cli ?? 'claude'), so the option-level
  // default is only reachable through a direct attach() call.
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const runDir = makeRunDir();
  const script = `import { attach } from ${JSON.stringify(ATTACH)};
attach({ session: 'agent-def', runDir: ${JSON.stringify(runDir)}, noOpen: true });`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, PATH: `${stubs.dir}:${process.env.PATH}` },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Starting claude: 'claude'/);
});

test('--dir sets the tmux new-session working directory', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const workDir = mkdtempSync(join(scratch, 'work-'));
  const { code } = runAttach(
    ['agent-wd', '--cli=claude', `--run-dir=${makeRunDir()}`, '--no-open', `--dir=${workDir}`],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stubs.log('tmux'), new RegExp(`new-session -d -s agent-wd -c ${workDir}`));
});
