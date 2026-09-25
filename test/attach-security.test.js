import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCliCommand,
  buildPipePaneCommand,
  shellQuote,
  splitShellWords,
  validateSessionName,
} from '../dist/attach.js';
import {
  defaultRunDir,
  ensurePrivateDirectory,
  ensurePrivateLogFile,
  resolveRunDir,
} from '../dist/run-dir.js';

const scratch = join(process.cwd(), '.pluk-test-run');

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test('session names reject shell metacharacters, traversal, quotes, and spaces', () => {
  for (const session of ['ok', 'agent_1.2-3']) {
    assert.doesNotThrow(() => validateSessionName(session));
  }

  for (const session of ['bad; rm -rf .', 'bad$(id)', '../escape', 'has space', 'quote"']) {
    assert.throws(() => validateSessionName(session), /Unsafe session name/);
  }
});

test('CLI commands and args are parsed and shell-quoted before tmux sends them', () => {
  const cmd = buildCliCommand('gh copilot', '--repo "owner/repo with spaces" ; rm -rf . $(id) "quoted value"');

  assert.equal(
    cmd,
    "'gh' 'copilot' '--repo' 'owner/repo with spaces' ';' 'rm' '-rf' '.' '$(id)' 'quoted value'",
  );
});

test('pipe-pane shell command quotes PLUK_RUN_DIR, pluk command, session, cli, and log file', () => {
  const cmd = buildPipePaneCommand({
    runDir: "run dir/$(id)'x",
    plukBin: 'npx --yes @hivecommons/pluk',
    session: 'agent_1',
    cli: 'claude',
    includeRaw: true,
    logFile: "logs/agent one'; rm.jsonl",
  });

  assert.equal(
    cmd,
    "PLUK_RUN_DIR='run dir/$(id)'\\''x' 'npx' '--yes' '@hivecommons/pluk' watch 'agent_1' --cli='claude' --include-raw >> 'logs/agent one'\\''; rm.jsonl'",
  );
});

test('shellQuote handles hostile strings without leaving unquoted metacharacters', () => {
  assert.equal(shellQuote("a b'; rm -rf .; echo '$(id)"), "'a b'\\''; rm -rf .; echo '\\''$(id)'");
});

test('splitShellWords preserves quoted spaces and hostile literals', () => {
  assert.deepEqual(splitShellWords('cmd "two words" \'$(id)\' semi;colon'), [
    'cmd',
    'two words',
    '$(id)',
    'semi;colon',
  ]);
});

test('default run dir is per-user under XDG_RUNTIME_DIR when available', () => {
  const old = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(scratch, 'xdg runtime');
  try {
    assert.equal(defaultRunDir(), join(scratch, 'xdg runtime', 'pluk'));
    assert.equal(resolveRunDir(), join(scratch, 'xdg runtime', 'pluk'));
  } finally {
    if (old === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = old;
  }
});

test('run and logs directories are created or repaired to mode 0700', () => {
  const dir = join(scratch, 'mode-dir');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  ensurePrivateDirectory(dir);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
});

test('symlinked run directories and log files are refused', () => {
  const target = join(scratch, 'target');
  const dirLink = join(scratch, 'dir-link');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  symlinkSync(target, dirLink, 'dir');
  assert.throws(() => ensurePrivateDirectory(dirLink), /symlinked directory/);

  const logTarget = join(scratch, 'target.jsonl');
  const logLink = join(scratch, 'log-link.jsonl');
  writeFileSync(logTarget, '');
  symlinkSync(logTarget, logLink);
  assert.throws(() => ensurePrivateLogFile(logLink), /symlinked log file/);
});

test('transcripts are created or repaired to mode 0600', () => {
  const dir = join(scratch, 'logs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'agent.jsonl');
  ensurePrivateLogFile(file);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);

  writeFileSync(file, '{}\n');
  chmodSync(file, 0o644);
  ensurePrivateLogFile(file);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
});
