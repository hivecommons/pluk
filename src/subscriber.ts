import { type FileHandle, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { type PlukEvent, type PlukEventType, parseEvent } from './event.js';
import { resolveRunDir, validateSessionName } from './run-dir.js';
import { ANSI_DIM, ANSI_RESET, sanitizeField } from './ansi.js';

const POLL_INTERVAL_MS = 200;
const READ_CHUNK_BYTES = 16384;
const FILE_WAIT_TIMEOUT_MS = 60_000;
const FILE_WAIT_POLL_MS = 1_000;

/**
 * Bounded aggregate health counters for one subscriber: fixed categories
 * only, no session names or event payloads.
 */
export interface SubscriberStats {
  /** Non-blank lines read from the log file. */
  linesRead: number;
  /** Lines that were not a well-formed pluk event and were skipped. */
  malformedLines: number;
  /** Well-formed events dropped by the --filter set. */
  eventsFiltered: number;
  /** Events emitted to listeners. */
  eventsEmitted: number;
}

export interface SubscriberOptions {
  session: string;
  runDir?: string;
  filter?: PlukEventType[];
  fromBeginning?: boolean;
  verbose?: boolean;
}

export class Subscriber extends EventEmitter {
  private session: string;
  private runDir: string;
  private filterSet: Set<PlukEventType> | null;
  private fromBeginning: boolean;
  private aborted = false;
  private verbose: boolean;
  private counters: SubscriberStats = { linesRead: 0, malformedLines: 0, eventsFiltered: 0, eventsEmitted: 0 };
  private eventCount = 0;
  /** Last non-blank line consumed — the resume marker after a rotation. */
  private lastLine = '';

  /** Snapshot of the health counters accumulated so far. */
  stats(): SubscriberStats {
    return { ...this.counters };
  }

  constructor(opts: SubscriberOptions) {
    super();
    // The session becomes a path segment of logFile — reject anything that
    // could traverse out of the private run dir (e.g. "../../etc/foo").
    validateSessionName(opts.session);
    this.session = opts.session;
    this.runDir = resolveRunDir(opts.runDir);
    this.filterSet = opts.filter ? new Set(opts.filter) : null;
    this.fromBeginning = opts.fromBeginning ?? false;
    this.verbose = opts.verbose ?? false;
  }

  private log(msg: string): void {
    if (this.verbose) {
      console.error(`${ANSI_DIM}[pluk:sub]${ANSI_RESET} ${msg}`);
    }
  }

  get logFile(): string {
    return join(this.runDir, 'logs', `${this.session}.jsonl`);
  }

  async start(): Promise<void> {
    const path = this.logFile;
    this.log(`waiting for log file: ${path}`);

    const deadline = Date.now() + FILE_WAIT_TIMEOUT_MS;
    while (!this.aborted) {
      try {
        const info = await stat(path);
        this.log(`log file found (${info.size} bytes)`);
        break;
      } catch {
        if (Date.now() > deadline) {
          this.emit('error', new Error(`Timeout waiting for ${path}`));
          return;
        }
        await sleep(FILE_WAIT_POLL_MS);
      }
    }

    if (this.aborted) return;

    const fh = await open(path, 'r');
    try {
      if (!this.fromBeginning) {
        const info = await fh.stat();
        await fh.read({ position: info.size, buffer: Buffer.alloc(0) });
      }

      let position = this.fromBeginning ? 0 : (await fh.stat()).size;
      let partial = '';
      this.log(`tailing from position ${position}${this.filterSet ? ` (filter: ${[...this.filterSet].join(',')})` : ''}`);

      while (!this.aborted) {
        const buf = Buffer.alloc(READ_CHUNK_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, position);

        if (bytesRead === 0) {
          // `pluk watch` rotates the log in place (truncate + rewrite of the
          // last N lines), so the file can shrink below our offset. A read
          // at a stale offset returns nothing forever and the tail silently
          // stalls — every later event, including the ones a rationguard
          // watcher exists to catch, is lost with no error. Detect the
          // shrink and resume from the kept tail, skipping lines already
          // delivered.
          const size = (await fh.stat()).size;
          if (size < position) {
            this.log(`log file shrank (${position} → ${size} bytes); resuming after rotation`);
            const resumed = await this.resumeAfterRotation(fh);
            position = resumed.position;
            partial = resumed.partial;
            continue;
          }
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        position += bytesRead;
        const chunk = partial + buf.toString('utf-8', 0, bytesRead);
        const lines = chunk.split('\n');
        partial = lines.pop() ?? '';

        for (const line of lines) this.consumeLine(line);
      }
    } finally {
      await fh.close();
    }
  }

  /**
   * Re-read a rotated log from the start and deliver only what follows the
   * last line this subscriber already consumed. Rotation keeps the newest N
   * lines, so that line is normally still present; if it is not (the
   * subscriber lagged by more than N lines) everything in the file is newer
   * than anything delivered, and it is all replayed.
   */
  private async resumeAfterRotation(fh: FileHandle): Promise<{ position: number; partial: string }> {
    const chunks: Buffer[] = [];
    let position = 0;
    for (;;) {
      const buf = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      position += bytesRead;
    }

    const lines = Buffer.concat(chunks).toString('utf-8').split('\n');
    const partial = lines.pop() ?? '';
    const marker = this.lastLine ? lines.lastIndexOf(this.lastLine) : -1;
    for (const line of lines.slice(marker + 1)) this.consumeLine(line);
    return { position, partial };
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    this.lastLine = line;
    this.counters.linesRead++;
    const event = parseEvent(line);
    if (!event) {
      this.counters.malformedLines++;
      return;
    }
    if (this.filterSet && !this.filterSet.has(event.type)) {
      this.counters.eventsFiltered++;
      return;
    }
    this.eventCount++;
    this.counters.eventsEmitted++;
    if (this.eventCount <= 3 || this.eventCount % 100 === 0) {
      // `data.to` is agent-controlled for model_changed events (it is the
      // raw terminal line), so never echo it to the terminal unsanitised.
      const to = event.data['to'];
      this.log(`event #${this.eventCount}: ${sanitizeField(event.type)}${to ? ` → ${sanitizeField(to)}` : ''}`);
    }
    this.emit('event', event);
  }

  stop(): void {
    this.aborted = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function subscribe(
  session: string,
  callback: (event: PlukEvent) => void,
  opts?: Omit<SubscriberOptions, 'session'>,
): Subscriber {
  const sub = new Subscriber({ session, ...opts });
  sub.on('event', callback);
  sub.start().catch(err => sub.emit('error', err));
  return sub;
}
