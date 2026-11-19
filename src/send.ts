import { writeLocalStats } from './local-stats.js';
import { exactTarget, tmuxSendKeys } from './tmux.js';

export interface SendOptions {
  session: string;
  text: string;
  enter?: boolean;
  literal?: boolean;
}

/**
 * Build the tmux argv list(s) for a send. Exported for unit testing.
 *
 * Text is sent literally (`-l`) whenever `literal` or `enter` is set —
 * matching the previous behaviour, where only the bare no-flag form kept
 * tmux key-name lookup (so `pluk send s C-c` still sends the key). The
 * Enter keypress is always a separate non-literal send-keys call so it is
 * interpreted as the key, never typed as the word "Enter".
 */
export function buildSendCommands(opts: SendOptions): string[][] {
  const { session, text, enter = false, literal = false } = opts;
  const args = ['send-keys'];
  if (literal || enter) args.push('-l');
  // `--` ends option parsing so text starting with '-' is never read as a flag.
  // tmux's argv parser treats an argument ending in ';' as a command separator
  // and strips it (dropping the argument if it becomes empty); only a trailing
  // '\;' survives as a literal ';'. -l and `--` do not disable this.
  const safeText = text.endsWith(';') ? text.slice(0, -1) + '\\;' : text;
  args.push('-t', exactTarget(session), '--', safeText);

  const commands = [args];
  if (enter) {
    commands.push(['send-keys', '-t', exactTarget(session), 'Enter']);
  }
  return commands;
}

let tmuxSendFailures = 0;

/**
 * Runs one tmux call and, for `send-keys`, counts a failure and publishes the
 * `send` stats snapshot. Both pluk send and attach's launch keys use this
 * process-local counter, so the transport seam in tmux.ts stays a pure wrapper.
 */
export function runWithSendStats(args: string[], run: (args: string[]) => void, runDir?: string): void {
  try {
    run(args);
  } catch (err) {
    if (args[0] === 'send-keys') tmuxSendFailures++;
    throw err;
  } finally {
    if (args[0] === 'send-keys') writeLocalStats('send', { tmuxSendFailures }, runDir);
  }
}

export function send(opts: SendOptions): void {
  // execFileSync passes argv directly — no shell, so no escaping and no
  // corruption of characters like `!`, `$`, backslash, or quotes, and a
  // session name with spaces or metacharacters cannot break the command.
  for (const args of buildSendCommands(opts)) {
    runWithSendStats(args, tmuxSendKeys);
  }
}
