import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvent, type PlukEvent } from './event.js';
import { resolveRunDir } from './run-dir.js';
import { tmuxListSessionNames } from './tmux.js';

const SECONDS_PER_MINUTE = 60;
// C0 controls, DEL, and C1 controls — covers ESC (CSI/OSC introducers), BEL,
// and every other terminal control byte an attacker could plant in a log
// field or log filename.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Strip terminal control characters from a value sourced from a JSONL log
 * or a log filename. `pluk sessions` prints these values directly to the
 * user's terminal; without this, a crafted log entry (or a hostile file in
 * a shared run dir) can inject ANSI/OSC escape sequences — clearing the
 * screen, retitling the window, or abusing terminal-specific escapes.
 */
export function sanitizeField(value: string): string {
  return value.replace(CONTROL_CHARS_RE, '');
}
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const MAX_TAIL_LINES = 100;

export interface SessionInfo {
  session: string;
  cli: string;
  state: string;
  lastActivity: string;
  lastActivityAgo: string;
  eventCount: number;
  logFile: string;
  tmuxAlive: boolean;
}

function readLastEvents(filePath: string, maxEvents: number): PlukEvent[] {
  const events: PlukEvent[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const start = Math.max(0, lines.length - MAX_TAIL_LINES);

    for (let i = lines.length - 1; i >= start && events.length < maxEvents; i--) {
      const event = parseEvent(lines[i]);
      if (event) events.unshift(event);
    }
  } catch {
    // file unreadable
  }
  return events;
}

function formatAgo(isoTimestamp: string): string {
  const diff = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < SECONDS_PER_MINUTE) return `${diff}s ago`;
  if (diff < SECONDS_PER_HOUR) return `${Math.floor(diff / SECONDS_PER_MINUTE)}m ago`;
  if (diff < SECONDS_PER_DAY) return `${Math.floor(diff / SECONDS_PER_HOUR)}h ago`;
  return `${Math.floor(diff / SECONDS_PER_DAY)}d ago`;
}

function getTmuxSessions(): Set<string> {
  const sessions = new Set<string>();
  try {
    for (const name of tmuxListSessionNames()) {
      sessions.add(name);
    }
  } catch {
    // tmux not running or not installed
  }
  return sessions;
}

function countEvents(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
}

export function discoverSessions(runDir?: string): SessionInfo[] {
  const dir = resolveRunDir(runDir);
  const logsDir = join(dir, 'logs');

  let files: string[];
  try {
    files = readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const tmuxSessions = getTmuxSessions();
  const results: SessionInfo[] = [];
  const MAX_TAIL_EVENTS = 50;

  for (const file of files) {
    const session = sanitizeField(file.replace('.jsonl', ''));
    const filePath = join(logsDir, file);
    const events = readLastEvents(filePath, MAX_TAIL_EVENTS);

    if (events.length === 0) continue;

    let cli = 'unknown';
    let state = 'unknown';
    let lastTs = '';

    for (const e of events) {
      if (e.ts > lastTs) lastTs = e.ts;

      if (e.data['cli'] && e.data['cli'] !== 'unknown') {
        cli = sanitizeField(e.data['cli']);
      }

      if (e.type === 'state_change') {
        state = sanitizeField(e.data['to'] ?? 'unknown');
      }
    }

    results.push({
      session,
      cli,
      state,
      lastActivity: lastTs,
      lastActivityAgo: lastTs ? formatAgo(lastTs) : 'unknown',
      eventCount: countEvents(filePath),
      logFile: filePath,
      tmuxAlive: tmuxSessions.has(session),
    });
  }

  results.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return results;
}
