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

export function tmuxHasSession(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
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

export function tmuxPipePane(session: string, pipeCmd: string): void {
  execFileSync('tmux', ['pipe-pane', '-t', session, '-o', pipeCmd], { stdio: 'inherit' });
}

export function tmuxAttach(session: string): void {
  execFileSync('tmux', ['attach', '-t', session], { stdio: 'inherit' });
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
