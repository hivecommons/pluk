import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateLogFile, resolveRunDir } from './run-dir.js';

const CLI_STARTUP_WAIT_MS = 1500;
const SAFE_SESSION_PATTERN = /^[A-Za-z0-9._-]+$/;

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

function tmuxExists(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function validateSessionName(session: string): void {
  if (!SAFE_SESSION_PATTERN.test(session)) {
    throw new Error(`Unsafe session name "${session}". Use only letters, numbers, dot, underscore, and dash.`);
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

  const sessionExists = tmuxExists(session);
  log(`tmux session "${session}" exists: ${sessionExists}`);

  if (!sessionExists) {
    console.log(`Creating tmux session: ${session}`);
    const newSessionArgs = ['new-session', '-d', '-s', session, '-c', workDir];
    log(`execFile: tmux ${newSessionArgs.map(shellQuote).join(' ')}`);
    execFileSync('tmux', newSessionArgs, { stdio: 'inherit' });

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
    execFileSync('tmux', sendArgs, { stdio: 'inherit' });
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
    const pipeArgs = ['pipe-pane', '-t', session, '-o', pipeCmd];
    log(`execFile: tmux ${pipeArgs.map(shellQuote).join(' ')}`);
    execFileSync('tmux', pipeArgs, { stdio: 'inherit' });
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
      const existing = execFileSync('pgrep', ['-f', `rationguard watch ${session}`], {
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
        execFileSync('tmux', ['attach', '-t', session], { stdio: 'inherit' });
      } catch {
        console.log(`Session detached. To reattach: tmux attach -t ${session}`);
      }
    } else {
      console.log(`\nSession ready. To interact: tmux attach -t ${session}`);
      console.log(`To monitor: pluk subscribe ${session} --run-dir=${runDir}`);
    }
  }
}

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
