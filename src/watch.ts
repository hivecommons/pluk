import { Classifier, stripANSI } from './classifier.js';
import { type PatternSet, getPatterns } from './patterns.js';
import { type PlukEvent, type PlukEventType } from './event.js';
import { createInterface } from 'node:readline';
import { type Readable } from 'node:stream';
import { exactTarget, tmuxCapturePane } from './tmux.js';

const DEFAULT_CAPTURE_INTERVAL_MS = 1000;

/**
 * Bounded aggregate health counters for one watcher. Every field is a count
 * over a fixed category — never a session name, raw terminal output, or any
 * other user-provided value — so the snapshot is safe to log locally.
 */
export interface WatchStats {
  /** Stream mode: lines received from the input (before ANSI stripping). */
  linesSeen: number;
  /** Capture mode: `tmux capture-pane` polls attempted. */
  framesPolled: number;
  /** Capture mode: polls that threw (pane gone, tmux unavailable). */
  captureFailures: number;
  /** Stream mode: lines whose classification threw and were dropped. */
  classifyErrors: number;
  /** Stream mode: readline/input stream 'error' events swallowed. */
  inputErrors: number;
  /** Events handed to onEvent (after filtering). */
  eventsEmitted: number;
  /** Classified events dropped by the --filter set. */
  eventsFiltered: number;
}

export function emptyWatchStats(): WatchStats {
  return {
    linesSeen: 0,
    framesPolled: 0,
    captureFailures: 0,
    classifyErrors: 0,
    inputErrors: 0,
    eventsEmitted: 0,
    eventsFiltered: 0,
  };
}

export interface WatchOptions {
  session: string;
  cli?: string;
  patternsDir?: string;
  input?: Readable;
  filter?: PlukEventType[];
  includeRaw?: boolean;
  /**
   * 'stream' (default): classify stdin line-by-line (pipe-pane).
   * 'capture': poll `tmux capture-pane -p` and classify each whole rendered
   * frame at once (state_change only). Frame classification is order-immune
   * and also covers TUIs whose pipe-pane byte stream carries no line feeds.
   */
  mode?: 'stream' | 'capture';
  /** tmux pane target for capture mode; defaults to the session name. */
  pane?: string;
  /** Poll interval for capture mode in milliseconds (default 1000). */
  captureIntervalMs?: number;
  onEvent: (event: PlukEvent) => void;
}

export interface WatchHandle {
  stop: () => void;
  /** Snapshot of the health counters accumulated so far. */
  stats: () => WatchStats;
}

export function watch(opts: WatchOptions): WatchHandle {
  const cli = opts.cli ?? 'claude';
  const patterns: PatternSet = getPatterns(cli, opts.patternsDir);
  const filterSet = opts.filter ? new Set(opts.filter) : null;
  const stats = emptyWatchStats();
  const snapshot = (): WatchStats => ({ ...stats });
  const emit = (event: PlukEvent): void => {
    if (filterSet && !filterSet.has(event.type)) {
      stats.eventsFiltered++;
      return;
    }
    stats.eventsEmitted++;
    opts.onEvent(event);
  };

  if (opts.mode === 'capture') {
    const classifier = new Classifier({
      session: opts.session,
      patterns,
      source: 'capture-pane',
    });
    const target = opts.pane ?? exactTarget(opts.session);
    const intervalMs =
      opts.captureIntervalMs !== undefined && Number.isFinite(opts.captureIntervalMs) && opts.captureIntervalMs > 0
        ? opts.captureIntervalMs
        : DEFAULT_CAPTURE_INTERVAL_MS;

    const timer = setInterval(() => {
      stats.framesPolled++;
      try {
        const frame = tmuxCapturePane(target);
        const event = classifier.classifyFrame(frame);
        if (event) emit(event);
      } catch {
        // Pane may be gone or tmux unavailable — keep polling quietly, but
        // count it so --diagnostics can tell a quiet pane from a dead one.
        stats.captureFailures++;
      }
    }, intervalMs);

    return {
      stop() {
        clearInterval(timer);
      },
      stats: snapshot,
    };
  }

  const classifier = new Classifier({
    session: opts.session,
    patterns,
    source: 'watch',
  });

  const input = opts.input ?? process.stdin;
  const includeRaw = opts.includeRaw ?? false;

  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on('line', (raw: string) => {
    stats.linesSeen++;
    try {
      const clean = stripANSI(raw);
      if (!clean) return;

      const classified = classifier.classify(clean);
      if (classified) emit(classified);

      if (includeRaw) emit(classifier.rawOutput(raw));
    } catch {
      // Never crash on malformed input — pipe-pane dies if we exit
      stats.classifyErrors++;
    }
  });

  rl.on('error', () => {
    // Silently handle readline errors to keep pipe-pane alive
    stats.inputErrors++;
  });

  const onInputError = (): void => {
    // Silently handle input stream errors
    stats.inputErrors++;
  };
  input.on('error', onInputError);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      rl.close();
      input.off('error', onInputError);
    },
    stats: snapshot,
  };
}
