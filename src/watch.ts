import { Classifier, stripANSI } from './classifier.js';
import { type PatternSet, getPatterns } from './patterns.js';
import { type PlukEvent, type PlukEventType } from './event.js';
import { createInterface } from 'node:readline';
import { type Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const DEFAULT_CAPTURE_INTERVAL_MS = 1000;

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

export function watch(opts: WatchOptions): { stop: () => void } {
  const cli = opts.cli ?? 'claude';
  const patterns: PatternSet = getPatterns(cli, opts.patternsDir);
  const filterSet = opts.filter ? new Set(opts.filter) : null;

  if (opts.mode === 'capture') {
    const classifier = new Classifier({
      session: opts.session,
      patterns,
      source: 'capture-pane',
    });
    const target = opts.pane ?? opts.session;
    const intervalMs = opts.captureIntervalMs ?? DEFAULT_CAPTURE_INTERVAL_MS;

    const timer = setInterval(() => {
      try {
        const frame = execFileSync('tmux', ['capture-pane', '-p', '-t', target], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const event = classifier.classifyFrame(frame);
        if (event && (!filterSet || filterSet.has(event.type))) {
          opts.onEvent(event);
        }
      } catch {
        // Pane may be gone or tmux unavailable — keep polling quietly
      }
    }, intervalMs);

    return {
      stop() {
        clearInterval(timer);
      },
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
    try {
      const clean = stripANSI(raw);
      if (!clean) return;

      const classified = classifier.classify(clean);
      if (classified) {
        if (!filterSet || filterSet.has(classified.type)) {
          opts.onEvent(classified);
        }
      }

      if (includeRaw) {
        const rawEvent = classifier.rawOutput(raw);
        if (!filterSet || filterSet.has('raw_output')) {
          opts.onEvent(rawEvent);
        }
      }
    } catch {
      // Never crash on malformed input — pipe-pane dies if we exit
    }
  });

  rl.on('error', () => {
    // Silently handle readline errors to keep pipe-pane alive
  });

  input.on('error', () => {
    // Silently handle input stream errors
  });

  return {
    stop() {
      rl.close();
    },
  };
}
