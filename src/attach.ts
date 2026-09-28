import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateLogFile, resolveRunDir, validateSessionName } from './run-dir.js';
import { ANSI_DIM, ANSI_RESET } from './ansi.js';
import { tmuxAttach, tmuxHasSession, tmuxNewSession, tmuxPipePane, tmuxRunInherited } from './tmux.js';

// Re-exported for existing consumers; the validator lives with the other
// path-safety helpers in run-dir.ts.
export { validateSessionName } from './run-dir.js';

const CLI_STARTUP_WAIT_MS = 1500;

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
export function rationguardWatcherPattern(session: string): string {
  const escaped = session.replace(/\./g, '\\.');
  return `rationguard watch ${escaped}( |$)`;
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
    copilot: 'gh copilot',
    gemini: 'gemini',
    goose: 'goose session',
    codex: 'codex',
    aider: 'aider',
  };
  return CLI_COMMANDS[cli] ?? cli;
}

function resolveDangerousFlag(cli: string): string {
  const DANGEROUS_FLAGS: Record<string, string> = {
    claude: '--dangerously-skip-permissions',
    codex: '--full-auto',
    goose: '--non-interactive',
  };
  return DANGEROUS_FLAGS[cli] ?? '';
}

function resolvePlukBin(): string {
  const path = findExecutable(['pluk', 'pluk-classify']);
  if (path) return path;

  try {
    execFileSync('npx', ['--yes', '@hivecommons/pluk', 'version'], { stdio: 'ignore' });
    return 'npx --yes @hivecommons/pluk';
  } catch {
    // not available
  }

  return '';
}

function resolveRationguardBin(): string {
  return findExecutable(['rationguard']) || 'npx --yes @hivecommons/rationguard';
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
  const attachCommand = `${shellQuote(tmuxBin)} attach -t ${shellQuote(session)}`;

  switch (terminal) {
    case 'iterm2':
      try {
        execFileSync(
          'osascript',
          ['-e', `tell application "iTerm2" to create window with default profile command ${appleScriptString(attachCommand)}`],
          { stdio: 'ignore' },
        );
        console.log(`Opened iTerm2 window attached to tmux session: ${session}`);
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
        console.log(`Opened Terminal window attached to tmux session: ${session}`);
        return;
      } catch {
        // fall through
      }
      break;
  }

  console.log(`To interact with the agent: tmux attach -t ${session}`);
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
    ? (msg: string) => console.log(`${ANSI_DIM}[pluk]${ANSI_RESET} ${msg}`)
    : (_msg: string) => {};

  log(`session=${session} cli=${cli} runDir=${runDir} workDir=${workDir}`);

  const logsDir = join(runDir, 'logs');
  log(`Securing run directory: ${runDir}`);
  ensurePrivateDirectory(runDir);
  log(`Securing logs directory: ${logsDir}`);
  ensurePrivateDirectory(logsDir);

  const sessionExists = tmuxHasSession(session);
  log(`tmux session "${session}" exists: ${sessionExists}`);

  if (!sessionExists) {
    console.log(`Creating tmux session: ${session}`);
    log(`execFile: tmux new-session -d -s ${shellQuote(session)} -c ${shellQuote(workDir)}`);
    tmuxNewSession(session, workDir);

    let fullCmd = buildCliCommand(cliCmd, opts.cliArgs);
    if (opts.dangerouslySkipPermissions) {
      const dangerFlag = resolveDangerousFlag(cli);
      if (dangerFlag) {
        fullCmd += ` ${shellQuote(dangerFlag)}`;
      } else {
        log(`no dangerous/auto flag known for cli=${cli}, skipping`);
      }
    }
    console.log(`Starting ${cli}: ${fullCmd}`);
    const sendArgs = ['send-keys', '-t', session, fullCmd, 'Enter'];
    log(`execFile: tmux ${sendArgs.map(shellQuote).join(' ')}`);
    tmuxRunInherited(sendArgs);
  } else {
    console.log(`Attaching to existing tmux session: ${session}`);
    if (opts.dangerouslySkipPermissions) {
      const dangerFlag = resolveDangerousFlag(cli);
      if (dangerFlag) {
        console.log(`Warning: --dangerous was set but session already exists. The CLI may not have ${dangerFlag} enabled.`);
        console.log(`To restart with permissions skipped: pluk send ${session} C-c && tmux send-keys -t ${shellQuote(session)} ${shellQuote(buildCliCommand(cliCmd, dangerFlag))} Enter`);
      }
    }
  }

  const plukBin = resolvePlukBin();
  log(`pluk binary: ${plukBin || '(not found)'}`);
  const logFile = join(logsDir, `${session}.jsonl`);
  log(`log file: ${logFile}`);
  ensurePrivateLogFile(logFile);

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
    console.log(`Attaching pluk pipe-pane: ${cli}`);
    log(`execFile: tmux pipe-pane -t ${shellQuote(session)} -o ${shellQuote(pipeCmd)}`);
    tmuxPipePane(session, pipeCmd);
    log('pipe-pane attached successfully');
  } else {
    console.log('Warning: pluk binary not found, skipping pipe-pane attachment');
    console.log('Install globally: npm install -g @hivecommons/pluk');
  }

  console.log(`Pluk logs: ${logFile}`);

  if (opts.rationguard) {
    if (!opts.noOpen) {
      const tmuxBin = resolveTmuxPath();
      log(`opening terminal window (tmux=${tmuxBin}, terminal=${detectTerminal()})`);
      openTmuxInNewWindow(session);
    } else {
      log('skipping terminal window (--no-open)');
    }

    try {
      const existing = execFileSync('pgrep', ['-f', rationguardWatcherPattern(session)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (existing) {
        const pids = existing.split('\n').filter(p => p && p !== String(process.pid));
        if (pids.length > 0) {
          log(`killing ${pids.length} existing rationguard watcher(s) for ${session}: ${pids.join(', ')}`);
          execFileSync('kill', pids, { stdio: 'ignore' });
        }
      }
    } catch {
      // no existing watchers
    }

    const rgBin = resolveRationguardBin();
    log(`rationguard binary: ${rgBin}`);
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

    console.log(`Starting rationguard watcher in this terminal...`);
    console.log(`Detections will appear here. Ctrl+C to stop.\n`);

    const [cmd, ...args] = rgArgs;
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      detached: false,
    });

    process.on('SIGINT', () => {
      child.kill();
      process.exit(0);
    });
  } else {
    if (!opts.noOpen) {
      console.log(`\nAttaching to tmux session...`);
      try {
        tmuxAttach(session);
      } catch {
        console.log(`Session detached. To reattach: tmux attach -t ${session}`);
      }
    } else {
      console.log(`\nSession ready. To interact: tmux attach -t ${session}`);
      console.log(`To monitor: pluk subscribe ${session} --run-dir=${runDir}`);
    }
  }
}
