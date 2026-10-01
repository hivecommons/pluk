/** Default period for `--diagnostics` health summaries. */
const DIAGNOSTICS_INTERVAL_MS = 60_000;

/**
 * Opt-in, local-only health diagnostics (#102). Writes one JSON line per
 * period to stderr — never stdout, which carries the event stream — with the
 * bounded counters a watcher or subscriber accumulates, so an operator can
 * tell a quiet session from one that is repeatedly failing or discarding
 * input. The line names only fixed counter categories and the command;
 * no session name, raw output or other user-provided value is included,
 * and nothing is sent anywhere. Returns a function that writes a final
 * summary and stops the timer.
 */
export function startDiagnostics(
  command: 'watch' | 'subscribe',
  snapshot: () => Record<string, number>,
  flag: string | undefined,
  write: (line: string) => void = line => process.stderr.write(line + '\n'),
): () => void {
  if (!flag) return () => {};
  const seconds = flag === 'true' ? NaN : Number(flag);
  const intervalMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DIAGNOSTICS_INTERVAL_MS;
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
