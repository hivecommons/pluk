import { type PlukEvent, type PlukEventType, createEvent } from './event.js';
import { type PatternSet } from './patterns.js';

const STATE_DEBOUNCE_SECONDS = 2;
const TRUNCATE_MAX_RUNES = 120;

const ANSI_RE = /\x1b\[\??[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x0f|\x1b=|\x1b>/g;

export function stripANSI(line: string): string {
  return line.replace(ANSI_RE, '').trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

const TOOL_PAREN_RE = /\(([a-z]+)\)$/;
const TOOL_BULLET_RE = /[●✓]\s+([A-Za-z]+)/;

function extractTool(line: string): string {
  const parenMatch = TOOL_PAREN_RE.exec(line);
  if (parenMatch) return parenMatch[1];
  const bulletMatch = TOOL_BULLET_RE.exec(line);
  if (bulletMatch) return bulletMatch[1];
  return 'unknown';
}

const DURATION_RE = /\(([0-9.]+)s\)/;
const RESET_TIME_RE = /[0-9]{1,2}(:[0-9]{2})?\s*[aApP][mM]/;
const RESET_REL_RE = /in [0-9]+ (hour|minute|second)s?/;

function extractDuration(line: string): string {
  const m = DURATION_RE.exec(line);
  return m ? m[1] : '';
}

function extractResetTime(line: string): string {
  const abs = RESET_TIME_RE.exec(line);
  if (abs) return abs[0];
  const rel = RESET_REL_RE.exec(line);
  if (rel) return rel[0];
  return '';
}

export interface ClassifierOptions {
  session: string;
  pane?: string;
  source?: string;
  patterns: PatternSet;
  /** Injectable clock returning epoch seconds. Defaults to Date.now()/1000. */
  clock?: () => number;
}

export class Classifier {
  private patterns: PatternSet;
  private session: string;
  private pane: string;
  private source: string;
  private seq = 0;
  private currentState = 'unknown';
  private stateChangeTS = 0;
  // Deferred state verdict awaiting debounce-window expiry. The debounce
  // defers transitions instead of dropping them, so the last computed state
  // of a render burst wins once the window expires (issue #17).
  private pendingState = '';
  // Timestamp of the most recent working evidence. Claude Code draws its
  // input box (`❯`) continuously, including mid-turn, so `❯` alone is not
  // evidence of idleness while working evidence is fresh (issue #17).
  private lastWorkingEvidenceTS = Number.NEGATIVE_INFINITY;
  private clock: () => number;

  constructor(opts: ClassifierOptions) {
    this.patterns = opts.patterns;
    this.session = opts.session;
    this.pane = opts.pane ?? '0';
    this.source = opts.source ?? 'pipe-pane';
    this.clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Current debounced state ('unknown' | 'idle' | 'working'). */
  get state(): string {
    return this.currentState;
  }

  /**
   * Resolve a proposed state through the debounce. Transitions inside the
   * debounce window are deferred (kept pending), never dropped; when the
   * window expires the most recent pending verdict is emitted.
   */
  private resolveState(proposed: string, now: number): PlukEvent | null {
    if (proposed) {
      this.pendingState = proposed;
    }
    if (!this.pendingState) return null;
    if (this.pendingState === this.currentState) {
      this.pendingState = '';
      return null;
    }
    if (now - this.stateChangeTS < STATE_DEBOUNCE_SECONDS) {
      return null; // defer — pendingState survives until the window expires
    }
    const oldState = this.currentState;
    this.currentState = this.pendingState;
    this.pendingState = '';
    this.stateChangeTS = now;
    this.seq++;
    return createEvent(this.session, this.pane, this.source, this.seq, 'state_change', {
      from: oldState, to: this.currentState,
    });
  }

  /**
   * Classify a whole rendered capture-pane frame at once and return at most
   * one state_change. Evidence is combined by priority over the entire frame
   * rather than first-match per line, so the on-screen order of the input box
   * (`❯`, drawn above the status row) versus the `esc to interrupt` status
   * row does not matter:
   *
   *   blocked modal (trust dialog)  >  working  >  idle
   *
   * A frame showing a blocked modal yields no idle/working verdict. Only
   * state is resolved here; richer per-line events (tool calls, errors, …)
   * remain the job of the streaming classify() path, because a polled frame
   * re-renders the same lines every capture and would re-fire them.
   */
  classifyFrame(frame: string | string[]): PlukEvent | null {
    const rawLines = Array.isArray(frame) ? frame : frame.split('\n');
    const now = this.clock();

    let sawBlocked = false;
    let sawWorking = false;
    let sawIdle = false;

    for (const raw of rawLines) {
      const line = stripANSI(raw);
      if (!line) continue;
      if (this.patterns.trustDialog?.test(line)) sawBlocked = true;
      if (this.patterns.working?.test(line)) sawWorking = true;
      if (this.patterns.idle?.test(line)) sawIdle = true;
    }

    if (sawBlocked) {
      // Modal outranks both: discard any pending idle/working verdict.
      this.pendingState = '';
      return null;
    }

    let proposed = '';
    if (sawWorking) {
      proposed = 'working';
      this.lastWorkingEvidenceTS = now;
    } else if (sawIdle) {
      proposed = 'idle';
    }

    return this.resolveState(proposed, now);
  }

  classify(line: string): PlukEvent | null {
    if (!line) return null;

    const now = this.clock();

    // Record state evidence BEFORE the event checks: the working status row
    // (`⏵⏵ bypass permissions on … · esc to interrupt …`) also matches
    // BYPASS_PATTERN, whose check returns from the loop below and would
    // otherwise shadow the working marker entirely. Working evidence is
    // authoritative over the idle prompt: Claude Code draws the `❯` input
    // box continuously, including mid-turn, so a line matching IDLE_PATTERN
    // only proposes idle if no working evidence has been seen within the
    // debounce window (issue #17).
    let proposedState = '';
    if (this.patterns.working?.test(line)) {
      proposedState = 'working';
      this.lastWorkingEvidenceTS = now;
    } else if (this.patterns.idle?.test(line)) {
      if (now - this.lastWorkingEvidenceTS >= STATE_DEBOUNCE_SECONDS) {
        proposedState = 'idle';
      }
    }

    const checks: Array<[RegExp | null, PlukEventType, () => Record<string, string>]> = [
      [this.patterns.rateLimit, 'rate_limit', () => ({
        cli: this.patterns.cli, message: line, resets_at: extractResetTime(line),
      })],
      [this.patterns.login, 'login_required', () => ({
        cli: this.patterns.cli, prompt: line,
      })],
      [this.patterns.trustDialog, 'trust_dialog', () => ({
        prompt: line, auto_approved: 'false',
      })],
      [this.patterns.bypass, 'bypass_permissions', () => ({
        prompt: line, auto_approved: 'false',
      })],
      [this.patterns.toolStart, 'tool_call_started', () => ({
        tool: extractTool(line), input_preview: truncate(line, TRUNCATE_MAX_RUNES),
      })],
      [this.patterns.toolEnd, 'tool_call_completed', () => ({
        tool: extractTool(line), duration_ms: extractDuration(line),
      })],
      [this.patterns.error, 'error', () => ({
        message: line, severity: 'error',
      })],
      [this.patterns.model, 'model_changed', () => ({
        from: '', to: line,
      })],
      [this.patterns.sessionEnd, 'session_ended', () => ({
        cli: this.patterns.cli,
      })],
    ];

    for (const [re, type, dataFn] of checks) {
      if (re && re.test(line)) {
        // Keep the state evidence: an event line inside the debounce window
        // must not erase a pending state verdict.
        if (proposedState) this.pendingState = proposedState;
        this.seq++;
        return createEvent(this.session, this.pane, this.source, this.seq, type, dataFn());
      }
    }

    return this.resolveState(proposedState, now);
  }

  rawOutput(line: string): PlukEvent {
    this.seq++;
    return createEvent(this.session, this.pane, this.source, this.seq, 'raw_output', { line });
  }

  commandReceived(text: string, sender: string): PlukEvent {
    this.seq = 1000001;
    return createEvent(this.session, this.pane, this.source, this.seq, 'command_received', { text, sender });
  }
}
