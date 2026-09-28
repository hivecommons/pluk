export interface PlukEvent {
  v: number;
  ts: string;
  seq: number;
  pid: number;
  session: string;
  pane: string;
  source: string;
  type: PlukEventType;
  data: Record<string, string>;
}

export type PlukEventType =
  | 'raw_output'
  | 'state_change'
  | 'rate_limit'
  | 'login_required'
  | 'trust_dialog'
  | 'bypass_permissions'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'error'
  | 'model_changed'
  | 'session_ended'
  | 'command_received';

const EVENT_VERSION = 1;

export function createEvent(
  session: string,
  pane: string,
  source: string,
  seq: number,
  type: PlukEventType,
  data: Record<string, string>,
): PlukEvent {
  return {
    v: EVENT_VERSION,
    ts: new Date().toISOString().replace(/(\.\d{3})\d*Z/, '$1Z'),
    seq,
    pid: process.pid,
    session,
    pane,
    source,
    type,
    data,
  };
}

/**
 * Parse one JSONL log line into a PlukEvent, validating the envelope shape.
 *
 * Log files are append-only and can pick up corrupted or foreign lines
 * (interleaved writers, truncated appends). A blind `JSON.parse` cast lets a
 * single non-object line (`123`, `"x"`, `[]`) or an object missing `data`
 * flow into consumers that dereference `event.data[...]` — crashing
 * `pluk sessions` and verbose `pluk subscribe` outright. Anything that does
 * not carry the fields consumers dereference is rejected as null, exactly
 * like malformed JSON.
 */
export function parseEvent(line: string): PlukEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const e = parsed as Record<string, unknown>;
    if (typeof e['type'] !== 'string' || typeof e['ts'] !== 'string') return null;
    const data = e['data'];
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    for (const value of Object.values(data)) {
      if (typeof value !== 'string') return null;
    }
    return parsed as PlukEvent;
  } catch {
    return null;
  }
}
