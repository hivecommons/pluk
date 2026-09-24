import { execFileSync } from 'node:child_process';

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
  args.push('-t', session, text);

  const commands = [args];
  if (enter) {
    commands.push(['send-keys', '-t', session, 'Enter']);
  }
  return commands;
}

export function send(opts: SendOptions): void {
  // execFileSync passes argv directly — no shell, so no escaping and no
  // corruption of characters like `!`, `$`, backslash, or quotes, and a
  // session name with spaces or metacharacters cannot break the command.
  for (const args of buildSendCommands(opts)) {
    execFileSync('tmux', args, { stdio: 'pipe' });
  }
}
