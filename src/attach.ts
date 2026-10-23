import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateLogFile, resolveRunDir, validateSessionName } from './run-dir.js';
import { ANSI_DIM, paintStderr } from './ansi.js';
import { exactTarget, tmuxAttach, tmuxHasSession, tmuxNewSession, tmuxPipePane, tmuxRunInherited } from './tmux.js';
import { plukPackageSpec } from './version.js';

// Re-exported for existing consumers; the validator lives with the other
// path-safety helpers in run-dir.ts.
export { validateSessionName } from './run-dir.js';

export interface AttachOptions {
  session: string;
  cli?: string;
  cliCommand?: string;
  cliArgs?: string;
  runDir?: string;
  rationguard?: boolean;
  rebuttal?: 'log' | 'send';
  noRaw?: boolean;
  workDir?: string;
  noOpen?: boolean;
  verbose?: boolean;
  dangerouslySkipPermissions?: boolean;
  /** Explicit rationguard command (shell words); overrides PATH lookup. */
  rationguardBin?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the pgrep -f ERE that matches ONLY this session's rationguard
 * watcher. pgrep -f does an unanchored regex substring match, so a bare
 * `rationguard watch <session>` prefix-matches every session whose name
 * starts with ours (attaching "agent" would kill — and silently disable —
 * the rationguard watcher of "agent-2"). Dots in session names are regex
 * wildcards with the same overmatch effect. Escape them and require a
 * word boundary (a space — pgrep renders cmdline arg separators as
 * spaces — or end-of-cmdline) after the session name.
 */
export function rationguardWatcherPattern(session: string, rgBin?: string): string {
  const escaped = session.replace(/\./g, '\\.');
  const prefix = rgBin
    ? splitShellWords(rgBin).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ')
    : 'rationguard';
  return `${prefix} watch ${escaped}( |$)`;
}

/**
 * `pgrep -f` alone matches every process on the host, whoever owns it. A
 * foreign process whose cmdline happens to match the watcher pattern would
 * land in the kill list, `kill` would fail on it with EPERM, and the attach
 * would abort after the session and pipe-pane were wired but before the
 * watcher started. Restrict the reap to the invoking user's processes; the
 * uid form of `-u` is accepted by both procps and BSD/macOS pgrep.
 */
export function pgrepUserScope(getuid: (() => number) | null | undefined = process.getuid): string[] {
  return typeof getuid === 'function' ? ['-u', String(getuid())] : [];
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (quote) throw new Error('Unterminated quote in command arguments');
  if (current) words.push(current);
  return words;
}

export function buildCliCommand(cliCommand: string, cliArgs?: string): string {
  const words = [...splitShellWords(cliCommand), ...(cliArgs ? splitShellWords(cliArgs) : [])];
  if (words.length === 0) throw new Error('CLI command cannot be empty');
  return words.map(shellQuote).join(' ');
}

export function buildPipePaneCommand(opts: {
  runDir: string;
  plukBin: string;
  session: string;
  cli: string;
  includeRaw: boolean;
  logFile: string;
}): string {
  const plukWords = splitShellWords(opts.plukBin);
  if (plukWords.length === 0) throw new Error('pluk command cannot be empty');

  return [
    `PLUK_RUN_DIR=${shellQuote(opts.runDir)}`,
    ...plukWords.map(shellQuote),
    'watch',
    shellQuote(opts.session),
    `--cli=${shellQuote(opts.cli)}`,
    opts.includeRaw ? '--include-raw' : '',
    '>>',
    shellQuote(opts.logFile),
  ].filter(Boolean).join(' ');
}

function findExecutable(candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      return execFileSync('which', [candidate], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // try next candidate
    }
  }
  return '';
}

function resolveCliCommand(cli: string): string {
  const CLI_COMMANDS: Record<string, string> = {
    claude: 'claude',
    copilot: 'copilot',
    gemini: 'gemini',
    goose: 'goose session',
    codex: 'codex',
    aider: 'aider',
    omp: 'omp',
  };
  return CLI_COMMANDS[cli] ?? cli;
}

function resolveDangerousFlag(cli: string): string {
  const DANGEROUS_FLAGS: Record<string, string> = {
    claude: '--dangerously-skip-permissions',
    copilot: '--allow-all-tools',
    codex: '--full-auto',
    goose: '--non-interactive',
    omp: '--approval-mode yolo',
  };
  return DANGEROUS_FLAGS[cli] ?? '';
}

function resolvePlukBin(): string {
  const path = findExecutable(['pluk', 'pluk-classify']);
  if (path) return shellQuote(path);

  // Pin to the running release: the pipe-pane must run the same pluk that
  // performed the attach, not whatever `latest` the registry serves.
  const spec = plukPackageSpec();
  try {
    execFileSync('npx', ['--yes', spec, 'version'], { stdio: 'ignore' });
    return `npx --yes ${spec}`;
  } catch {
    // not available
  }

  return '';
}

/**
 * Resolve the rationguard command without ever fetching it implicitly.
 *
 * The old `npx --yes @hivecommons/rationguard` fallback ran whatever
 * `latest` the registry served at attach time — a process that reads the
 * private session log and, with `--rebuttal=send`, types into the agent's
 * tmux session. Only an explicit override (`--rationguard-bin` /
 * `PLUK_RATIONGUARD_BIN`) or a binary already on PATH is accepted; the
 * caller decides the version, not the registry's `latest` tag.
 */
export function resolveRationguardBin(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  lookup: (candidates: string[]) => string = findExecutable,
): string {
  const explicit = (override ?? env['PLUK_RATIONGUARD_BIN'] ?? '').trim();
  if (explicit) {
    const [first] = splitShellWords(explicit);
    if (!first || !lookup([first])) {
      throw new Error(
        `--rationguard-bin / PLUK_RATIONGUARD_BIN command not found or not executable: ${explicit}`,
      );
    }
    return explicit;
  }
  const found = lookup(['rationguard']);
  if (found) return shellQuote(found);
  throw new Error(
    'rationguard not found on PATH. Install it (npm install -g @hivecommons/rationguard) ' +
      'or pass --rationguard-bin=COMMAND (also PLUK_RATIONGUARD_BIN).',
  );
}

function detectTerminal(): 'iterm2' | 'terminal' | 'unknown' {
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  if (termProgram === 'iTerm.app') return 'iterm2';
  if (termProgram === 'Apple_Terminal') return 'terminal';
  if (process.platform === 'darwin') return 'terminal';
  return 'unknown';
}

function resolveTmuxPath(): string {
  return findExecutable(['tmux']) || 'tmux';
}

function openTmuxInNewWindow(session: string): void {
  const terminal = detectTerminal();
  const tmuxBin = resolveTmuxPath();
  const attachCommand = `${shellQuote(tmuxBin)} attach -t ${shellQuote(exactTarget(session))}`;

  switch (terminal) {
    case 'iterm2':
      try {
        execFileSync(
          'osascript',
          ['-e', `tell application "iTerm2" to create window with default profile command ${appleScriptString(attachCommand)}`],
          { stdio: 'ignore' },
        );
        console.error(`Opened iTerm2 window attached to tmux session: ${session}`);
        return;
      } catch {
        // fall through
      }
      break;

    case 'terminal':
      try {
        execFileSync(
          'osascript',
          ['-e', `tell application "Terminal" to do script ${appleScriptString(attachCommand)}`],
          { stdio: 'ignore' },
        );
        console.error(`Opened Terminal window attached to tmux session: ${session}`);
        return;
      } catch {
        // fall through
      }
      break;
  }

  console.error(`To interact with the agent: tmux attach -t ${session}`);
}

export function attach(opts: AttachOptions): void {
  const session = opts.session;
  validateSessionName(session);
  const cli = opts.cli ?? 'claude';
  const cliCmd = opts.cliCommand ?? resolveCliCommand(cli);
  const runDir = resolveRunDir(opts.runDir);
  const workDir = opts.workDir ?? process.cwd();
  const verbose = opts.verbose ?? false;

  const log = verbose
    ? (msg: string) => console.error(`${paintStderr(ANSI_DIM, '[pluk]')} ${msg}`)
    : (_msg: string) => {};

  log(`session=${session} cli=${cli} runDir=${runDir} workDir=${workDir}`);

  // Resolve before any tmux side effect so a missing rationguard fails the
  // attach cleanly instead of leaving a half-wired session behind.
  const rgBin = opts.rationguard ? resolveRationguardBin(opts.rationguardBin) : '';
  if (rgBin) log(`rationguard binary: ${rgBin}`);

  const logsDir = join(runDir, 'logs');
  log(`Securing run directory: ${runDir}`);
  ensurePrivateDirectory(runDir);
  log(`Securing logs directory: ${logsDir}`);
  ensurePrivateDirectory(logsDir);

  const plukBin = resolvePlukBin();
  log(`pluk binary: ${plukBin || '(not found)'}`);
  const logFile = join(logsDir, `${session}.jsonl`);
  log(`log file: ${logFile}`);
  ensurePrivateLogFile(logFile);

  const wirePipePane = (): void => {
    if (plukBin) {
      const pipeCmd = buildPipePaneCommand({
        runDir,
        plukBin,
        session,
        cli,
        includeRaw: !opts.noRaw,
        logFile,
      });
      log(`pipe-pane command: ${pipeCmd}`);
      console.error(`Attaching pluk pipe-pane: ${cli}`);
      log(`execFile: tmux pipe-pane -t ${shellQuote(exactTarget(session))} ${shellQuote(pipeCmd)}`);
      tmuxPipePane(session, pipeCmd);
      log('pipe-pane attached successfully');
    } else {
      console.error('Warning: pluk binary not found, skipping pipe-pane attachment');
      console.error('Install globally: npm install -g @hivecommons/pluk');
    }
  };

  const sessionExists = tmuxHasSession(session);
  log(`tmux session "${session}" exists: ${sessionExists}`);

  if (!sessionExists) {
    console.error(`Creating tmux session: ${session}`);
    log(`execFile: tmux new-session -d -s ${shellQuote(session)} -c ${shellQuote(workDir)}`);
    tmuxNewSession(session, workDir);
    wirePipePane();

    let fullCmd = buildCliCommand(cliCmd, opts.cliArgs);
    if (opts.dangerouslySkipPermissions) {
      const dangerFlag = resolveDangerousFlag(cli);
      if (dangerFlag) {
        // Word-split: some flags are two tokens (omp's `--approval-mode yolo`),
        // and a single shellQuote() would hand the CLI one argv entry.
        fullCmd += ` ${splitShellWords(dangerFlag).map(shellQuote).join(' ')}`;
      } else {
        log(`no dangerous/auto flag known for cli=${cli}, skipping`);
      }
    }
    console.error(`Starting ${cli}: ${fullCmd}`);
    const sendArgs = ['send-keys', '-t', exactTarget(session), '--', fullCmd, 'Enter'];
    log(`execFile: tmux ${sendArgs.map(shellQuote).join(' ')}`);
    tmuxRunInherited(sendArgs);
  } else {
    console.error(`Attaching to existing tmux session: ${session}`);
    if (opts.dangerouslySkipPermissions) {
      const dangerFlag = resolveDangerousFlag(cli);
      if (dangerFlag) {
        console.error(`Warning: --dangerous was set but session already exists. The CLI may not have ${dangerFlag} enabled.`);
        console.error(`To restart with permissions skipped: pluk send ${session} C-c && tmux send-keys -t ${shellQuote(exactTarget(session))} -- ${shellQuote(buildCliCommand(cliCmd, dangerFlag))} Enter`);
      }
    }
    if (opts.cliCommand !== undefined) {
      console.error('Warning: --command was set but session already exists; the running CLI was not restarted.');
    }
    if (opts.cliArgs !== undefined) {
      console.error('Warning: --cli-args was set but session already exists; the running CLI was not restarted.');
    }
    if (opts.workDir !== undefined) {
      console.error('Warning: --dir was set but session already exists; the working directory of the existing session was not changed.');
    }
    wirePipePane();
  }

  console.error(`Pluk logs: ${logFile}`);

  if (opts.rationguard) {
    if (!opts.noOpen) {
      const tmuxBin = resolveTmuxPath();
      log(`opening terminal window (tmux=${tmuxBin}, terminal=${detectTerminal()})`);
      openTmuxInNewWindow(session);
    } else {
      log('skipping terminal window (--no-open)');
    }

    // Both patterns may match the same process; collect PIDs once so kill never sees duplicates.
    const patterns = new Set([rationguardWatcherPattern(session, rgBin), rationguardWatcherPattern(session)]);
    const pids = new Set<string>();
    for (const pattern of patterns) {
      try {
        const existing = execFileSync('pgrep', [...pgrepUserScope(), '-f', pattern], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        for (const p of existing.split('\n')) {
          if (p && p !== String(process.pid)) pids.add(p);
        }
      } catch {
        // no existing watchers for this pattern
      }
    }
    if (pids.size > 0) {
      const list = [...pids];
      log(`killing ${list.length} existing rationguard watcher(s) for ${session}: ${list.join(', ')}`);
      execFileSync('kill', list, { stdio: 'ignore' });
    }

    const rgArgs = [
      ...splitShellWords(rgBin),
      'watch',
      session,
      `--run-dir=${runDir}`,
      `--cli=${cli}`,
      ...(opts.rebuttal ? [`--rebuttal=${opts.rebuttal}`] : []),
      ...(verbose ? ['--verbose'] : []),
    ];
    log(`rationguard command: ${rgArgs.map(shellQuote).join(' ')}`);

    console.error(`Starting rationguard watcher in this terminal...`);
    console.error(`Detections will appear here. Ctrl+C to stop.\n`);

    const [cmd, ...args] = rgArgs;
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      detached: false,
    });

    child.on('error', err => {
      console.error(`Failed to start rationguard (${cmd}): ${err.message}`);
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0));
    });

    process.on('SIGINT', () => {
      child.kill();
      process.exit(0);
    });
  } else {
    if (!opts.noOpen) {
      console.error(`\nAttaching to tmux session...`);
      try {
        tmuxAttach(session);
      } catch {
        console.error(`Session detached. To reattach: tmux attach -t ${session}`);
      }
    } else {
      console.error(`\nSession ready. To interact: tmux attach -t ${session}`);
      console.error(`To monitor: pluk subscribe ${session} --run-dir=${runDir}`);
    }
  }
}
