import { execFileSync } from 'node:child_process';

/**
 * Shared seam for every synchronous `tmux` invocation in pluk.
 *
 * Before this module existed, attach.ts, sessions.ts, watch.ts, and send.ts
 * each called `execFileSync('tmux', ...)` directly, and each picked its own
 * stdio/encoding/timeout options independently — e.g. only the
 * `list-sessions` call site set a timeout, so a hung tmux server could block
 * the others indefinitely. Routing every call through here keeps the
 * per-command options in one place and makes the tmux dependency explicit
 * and swappable (e.g. for testing) rather than duplicated ad hoc.
 */

/**
 * tmux resolves a bare `-t name` by prefix and fnmatch, and reads `a.b` as
 * window.pane. A leading `=` forces an exact session-name match, and the
 * trailing `:` makes pane-type commands (send-keys, pipe-pane, capture-pane)
 * accept it too; session-type commands (has-session, attach) accept it as well.
 */
export function exactTarget(session: string): string {
  return `=${session}:`;
}

export function tmuxHasSession(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', exactTarget(session)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function tmuxNewSession(session: string, workDir: string): void {
  execFileSync('tmux', ['new-session', '-d', '-s', session, '-c', workDir], { stdio: 'inherit' });
}

/** Runs an arbitrary `send-keys`-style argv with output passed through to the parent. */
export function tmuxRunInherited(args: string[]): void {
  execFileSync('tmux', args, { stdio: 'inherit' });
}

/**
 * Replaces any pipe already open on the pane with `pipeCmd`.
 *
 * Deliberately no `-o`: tmux's `-o` is a toggle ("only open a new pipe if
 * no previous pipe exists"), and tmux always closes the existing pipe
 * first. On a pane that `pluk attach` already piped, `-o` would therefore
 * close the running `pluk watch` and open nothing, silently turning event
 * logging off on every second attach. Without it the old pipe is closed
 * and the new one opened, so a repeat attach is idempotent.
 */
export function tmuxPipePane(session: string, pipeCmd: string): void {
  execFileSync('tmux', ['pipe-pane', '-t', exactTarget(session), pipeCmd], { stdio: 'inherit' });
}

export function tmuxAttach(session: string): void {
  execFileSync('tmux', ['attach', '-t', exactTarget(session)], { stdio: 'inherit' });
}

/** Runs a `send-keys`-style argv with stdio captured (not shown to the user). */
export function tmuxSendKeys(args: string[]): void {
  execFileSync('tmux', args, { stdio: 'pipe' });
}

export function tmuxListSessionNames(): string[] {
  const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function tmuxCapturePane(target: string): string {
  return execFileSync('tmux', ['capture-pane', '-p', '-t', target], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
