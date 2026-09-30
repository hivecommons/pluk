/**
 * Opt-in, local-only health diagnostics for event capture (`pluk watch`) and
 * event consumption (`pluk subscribe`).
 *
 * Counters are bounded to a fixed, known set of event/error categories —
 * never session names, raw terminal output, or other unbounded/user-provided
 * values — and are only ever written to stderr or returned in-process. There
 * is no exporter and nothing is sent off-box.
 */

/** Fixed set of counters tracked for a `pluk watch` process. */
export interface WatchDiagnostics {
  /** Lines/frames successfully classified into an event. */
  eventsEmitted: number;
  /** capture-pane polls that returned a frame (mode: 'capture' only). */
  capturePolls: number;
  /** capture-pane polls that threw (pane gone, tmux unavailable, etc). */
  captureFailures: number;
  /** stdin lines read and classified without error (mode: 'stream' only). */
  linesProcessed: number;
  /** stdin lines that threw while being classified. */
  lineErrors: number;
  /** readline/input stream error events. */
  streamErrors: number;
}

/** Fixed set of counters tracked for a `pluk subscribe` process. */
export interface SubscriberDiagnostics {
  /** JSONL lines that parsed into a valid event and passed the filter. */
  eventsEmitted: number;
  /** JSONL lines skipped because they were blank, malformed, or invalid. */
  malformedSkipped: number;
}

export function createWatchDiagnostics(): WatchDiagnostics {
  return {
    eventsEmitted: 0,
    capturePolls: 0,
    captureFailures: 0,
    linesProcessed: 0,
    lineErrors: 0,
    streamErrors: 0,
  };
}

export function createSubscriberDiagnostics(): SubscriberDiagnostics {
  return {
    eventsEmitted: 0,
    malformedSkipped: 0,
  };
}

/**
 * Start a periodic stderr reporter for a bounded counters snapshot. `snapshot`
 * is called fresh on every tick (and once immediately on `stop()`) so the
 * reported counters always reflect current totals. Returns a `stop()` that
 * clears the timer and writes one final summary.
 */
export function startDiagnosticsReporter<T extends object>(
  label: string,
  snapshot: () => T,
  intervalMs: number,
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): { stop: () => void } {
  const report = (): void => {
    sink(JSON.stringify({ diagnostics: label, ts: new Date().toISOString(), ...snapshot() }));
  };

  const timer = setInterval(report, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      report();
    },
  };
}
