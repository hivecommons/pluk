import { ANSI_RED, ANSI_DIM, paintStderr } from './ansi.js';

/** Write a leveled diagnostic line to stderr; colour only on a TTY without NO_COLOR. */
export function log(level: 'error' | 'warn' | 'info', msg: string, prefix?: string): void {
  if (process.env.PLUK_LOG_FORMAT === 'json') {
    console.error(JSON.stringify({ level, message: msg }));
    return;
  }
  // Optional text prefixes preserve existing CLI diagnostics for humans and scripts.
  const label = prefix ?? (level === 'error' ? 'Error:' : level === 'warn' ? 'Warning:' : '[pluk]');
  const tag = paintStderr(level === 'error' ? ANSI_RED : ANSI_DIM, label);
  console.error(label ? `${tag} ${msg}` : msg);
}

/** Default period for `--diagnostics` health summaries. */
const DIAGNOSTICS_INTERVAL_MS = 60_000;

/** Node turns delays above this signed 32-bit limit into a 1 ms timer. */
export const MAX_INTERVAL_MS = 2 ** 31 - 1;

/**
 * Opt-in, local-only health diagnostics (#102). Writes one JSON line per
 * period to stderr — never stdout, which carries the event stream — with the
 * bounded counters a watcher or subscriber accumulates, so an operator can
 * tell a quiet session from one that is repeatedly failing or discarding
 * input. The line names only fixed counter categories and the command;
 * no session name, raw output or other user-provided value is included,
 * and nothing is sent anywhere. Returns a function that writes a final
 * summary and stops the timer.
 *
 * `flag` is the raw `--diagnostics` value. The CLI validates it before
 * calling (exit 2 on anything that is not a positive, in-range number);
 * library callers that pass a non-finite or non-positive value get the
 * 60 s default instead. Finite positive periods above Node's timer limit
 * are capped at MAX_INTERVAL_MS.
 */
export function startDiagnostics(
  command: 'watch' | 'subscribe',
  snapshot: () => Record<string, number>,
  flag: string | undefined,
  write: (line: string) => void = line => process.stderr.write(line + '\n'),
): () => void {
  if (!flag) return () => {};
  const seconds = flag === 'true' ? NaN : Number(flag);
  const intervalMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_INTERVAL_MS)
    : DIAGNOSTICS_INTERVAL_MS;
  const startedAt = Date.now();
  const report = (final: boolean): void => {
    try {
      write(JSON.stringify({
        pluk_diagnostics: 1,
        command,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        final,
        ...snapshot(),
      }));
    } catch {
      // Diagnostics must never take the watcher down with them.
    }
  };
  const timer = setInterval(() => report(false), intervalMs);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    report(true);
  };
}
