import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { type PlukEvent, type PlukEventType, parseEvent } from './event.js';
import { resolveRunDir } from './run-dir.js';

const POLL_INTERVAL_MS = 200;
const FILE_WAIT_TIMEOUT_MS = 60_000;
const FILE_WAIT_POLL_MS = 1_000;

export interface SubscriberOptions {
  session: string;
  runDir?: string;
  filter?: PlukEventType[];
  fromBeginning?: boolean;
  verbose?: boolean;
}

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';

export class Subscriber extends EventEmitter {
  private session: string;
  private runDir: string;
  private filterSet: Set<PlukEventType> | null;
  private fromBeginning: boolean;
  private aborted = false;
  private verbose: boolean;

  constructor(opts: SubscriberOptions) {
    super();
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
      let eventCount = 0;
      this.log(`tailing from position ${position}${this.filterSet ? ` (filter: ${[...this.filterSet].join(',')})` : ''}`);

      while (!this.aborted) {
        const buf = Buffer.alloc(16384);
        const { bytesRead } = await fh.read(buf, 0, buf.length, position);

        if (bytesRead === 0) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        position += bytesRead;
        const chunk = partial + buf.toString('utf-8', 0, bytesRead);
        const lines = chunk.split('\n');
        partial = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = parseEvent(line);
          if (!event) continue;
          if (this.filterSet && !this.filterSet.has(event.type)) continue;
          eventCount++;
          if (eventCount <= 3 || eventCount % 100 === 0) {
            this.log(`event #${eventCount}: ${event.type}${event.data['to'] ? ` → ${event.data['to']}` : ''}`);
          }
          this.emit('event', event);
        }
      }
    } finally {
      await fh.close();
    }
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
