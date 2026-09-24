import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PLUK_DEFAULT_RUN_DIR = '/tmp/pluk-run';
const CLI_STARTUP_WAIT_MS = 1500;

// tmux session names and --cli values are embedded in shell contexts that
// cannot take an argv (tmux pipe-pane -o, pgrep -f), so restrict them to a
// safe charset. This also prevents `../` traversal into the log-file path.
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeName(value: string, what: string): void {
  if (!SAFE_NAME_RE.test(value)) {
    throw new Error(
      `Invalid ${what} "${value}": only letters, digits, ".", "_" and "-" are allowed`,
    );
  }
}

/** Single-quote a string for safe embedding in a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  try {
    const path = execSync('which pluk 2>/dev/null || which pluk-classify 2>/dev/null', {
      encoding: 'utf-8',
    }).trim();
    return path;
  } catch {
    // fall back to npx
  }

  try {
    execSync('npx --yes @hivecommons/pluk version 2>/dev/null', { stdio: 'ignore' });
    return 'npx --yes @hivecommons/pluk';
  } catch {
    // not available
  }

  return '';
}

function resolveRationguardBin(): string {
  try {
    return execSync('which rationguard 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch {
    return 'npx --yes @hivecommons/rationguard';
  }
}

function detectTerminal(): 'iterm2' | 'terminal' | 'unknown' {
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  if (termProgram === 'iTerm.app') return 'iterm2';
  if (termProgram === 'Apple_Terminal') return 'terminal';
  if (process.platform === 'darwin') return 'terminal';
  return 'unknown';
}

function resolveTmuxPath(): string {
  try {
    return execSync('which tmux', { encoding: 'utf-8' }).trim();
  } catch {
    return 'tmux';
  }
}

function openTmuxInNewWindow(session: string): void {
  const terminal = detectTerminal();
  const tmuxBin = resolveTmuxPath();

  switch (terminal) {
    case 'iterm2':
      try {
        execSync(
          `osascript -e 'tell application "iTerm2" to create window with default profile command "${tmuxBin} attach -t ${session}"'`,
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
        execSync(
          `osascript -e 'tell application "Terminal" to do script "${tmuxBin} attach -t ${session}"'`,
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
  const cli = opts.cli ?? 'claude';
  assertSafeName(session, 'session name');
  assertSafeName(cli, 'cli name');
  const cliCmd = opts.cliCommand ?? resolveCliCommand(cli);
  const runDir = opts.runDir ?? process.env['PLUK_RUN_DIR'] ?? PLUK_DEFAULT_RUN_DIR;
  const workDir = opts.workDir ?? process.cwd();
  const verbose = opts.verbose ?? false;

  const log = verbose
    ? (msg: string) => console.log(`${ANSI_DIM}[pluk]${ANSI_RESET} ${msg}`)
    : (_msg: string) => {};

  log(`session=${session} cli=${cli} runDir=${runDir} workDir=${workDir}`);

  const logsDir = join(runDir, 'logs');
  if (!existsSync(logsDir)) {
    log(`Creating logs directory: ${logsDir}`);
    mkdirSync(logsDir, { recursive: true });
  }

  const sessionExists = tmuxExists(session);
  log(`tmux session "${session}" exists: ${sessionExists}`);

  if (!sessionExists) {
    console.log(`Creating tmux session: ${session}`);
    const newSessionArgs = ['new-session', '-d', '-s', session, '-c', workDir];
    log(`exec: tmux ${newSessionArgs.join(' ')}`);
    execFileSync('tmux', newSessionArgs, { stdio: 'inherit' });

    let fullCmd = cliCmd;
    if (opts.cliArgs) {
      fullCmd += ` ${opts.cliArgs}`;
    }
    if (opts.dangerouslySkipPermissions) {
      const dangerFlag = resolveDangerousFlag(cli);
      if (dangerFlag) {
        fullCmd += ` ${dangerFlag}`;
      } else {
        log(`no dangerous/auto flag known for cli=${cli}, skipping`);
      }
    }
    console.log(`Starting ${cli}: ${fullCmd}`);
    const sendArgs = ['send-keys', '-t', session, fullCmd, 'Enter'];
    log(`exec: tmux ${sendArgs.join(' ')}`);
    execFileSync('tmux', sendArgs, { stdio: 'inherit' });
  } else {
    console.log(`Attaching to existing tmux session: ${session}`);
    if (opts.dangerouslySkipPermissions) {
      const dangerFlag = resolveDangerousFlag(cli);
      if (dangerFlag) {
        console.log(`Warning: --dangerous was set but session already exists. The CLI may not have ${dangerFlag} enabled.`);
        console.log(`To restart with permissions skipped: tmux send-keys -t ${session} C-c && tmux send-keys -t ${session} "${cliCmd} ${dangerFlag}" Enter`);
      }
    }
  }

  const plukBin = resolvePlukBin();
  log(`pluk binary: ${plukBin || '(not found)'}`);
  const includeRawFlag = opts.noRaw ? '' : ' --include-raw';

  const logFile = join(logsDir, `${session}.jsonl`);
  log(`log file: ${logFile}`);

  if (plukBin) {
    // pipe-pane's -o argument is executed by tmux's shell, so quote every
    // free-form path component; session and cli are charset-validated above.
    const pipeCmd = `PLUK_RUN_DIR=${shellQuote(runDir)} ${plukBin} watch ${session} --cli=${cli}${includeRawFlag} >> ${shellQuote(logFile)}`;
    log(`pipe-pane command: ${pipeCmd}`);
    console.log(`Attaching pluk pipe-pane: ${cli}`);
    const pipeArgs = ['pipe-pane', '-t', session, '-o', pipeCmd];
    log(`exec: tmux ${pipeArgs.join(' ')}`);
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
      const existing = execFileSync('pgrep', ['-f', `rationguard watch ${session}`], { encoding: 'utf-8' }).trim();
      if (existing) {
        const pids = existing.split('\n').filter(p => /^\d+$/.test(p) && p !== String(process.pid));
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
    // rgBin may be multi-word (e.g. "npx --yes @hivecommons/rationguard").
    const rgParts = rgBin.split(' ').filter(Boolean);
    const rgArgs = [
      ...rgParts.slice(1),
      'watch',
      session,
      `--run-dir=${runDir}`,
      `--cli=${cli}`,
    ];
    if (opts.rebuttal) rgArgs.push(`--rebuttal=${opts.rebuttal}`);
    if (verbose) rgArgs.push('--verbose');
    log(`rationguard command: ${rgParts[0]} ${rgArgs.join(' ')}`);

    console.log(`Starting rationguard watcher in this terminal...`);
    console.log(`Detections will appear here. Ctrl+C to stop.\n`);

    const child = spawn(rgParts[0], rgArgs, {
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
