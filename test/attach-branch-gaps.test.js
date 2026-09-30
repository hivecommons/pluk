// Branch-gap tests for src/attach.ts — the arms attach-orchestration.test.js
// and cli.test.js still leave untaken (78.72% branch coverage):
//   - splitShellWords: trailing backslash, unterminated quote
//   - buildCliCommand: empty command throw, cliArgs merge
//   - buildPipePaneCommand: empty pluk command throw, includeRaw off
//   - resolveCliCommand fallback for a CLI with no known command mapping
//   - resolveRationguardBin npx fallback when `which rationguard` fails
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
import { splitShellWords, buildCliCommand, buildPipePaneCommand } from '../dist/attach.js';

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
  assert.match(stubs.log('tmux'), /send-keys -t agent-fb 'somecli' Enter/);
});

// --- resolveRationguardBin npx fallback ----------------------------------------------

test('rationguard watcher falls back to npx when `which rationguard` fails', () => {
  const stubs = makeStubs({ which: ['tmux', 'pluk'] });
  const { code, stdout } = runAttach(
    ['agent-rg', `--run-dir=${makeRunDir()}`, '--no-open', '--rationguard'],
    stubs,
  );
  assert.equal(code, 0);
  assert.match(stdout, /Starting rationguard watcher/);
  assert.match(stubs.log('npx'), /--yes @hivecommons\/rationguard watch agent-rg/);
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
