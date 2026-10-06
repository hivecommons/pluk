/**
 * Shared ANSI escape codes for terminal output. Centralized here so the
 * codes are defined once instead of being redeclared independently in
 * every module that prints colored/dim text (attach.ts, cli.ts,
 * subscriber.ts previously each had their own private copies).
 */
export const ANSI_RED = '\x1b[31m';
export const ANSI_GREEN = '\x1b[32m';
export const ANSI_CYAN = '\x1b[36m';
export const ANSI_DIM = '\x1b[2m';
export const ANSI_BOLD = '\x1b[1m';
export const ANSI_RESET = '\x1b[0m';

// C0 controls, DEL, and C1 controls — covers ESC (CSI/OSC introducers), BEL,
// and every other terminal control byte that could be planted in a log
// field, a log filename, or a monitored agent's output.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Strip terminal control characters from an untrusted value before it is
 * printed to the user's terminal. Applies to anything sourced from a JSONL
 * log, a log filename, or an event field derived from agent output: without
 * this, a crafted value can inject ANSI/OSC escape sequences — clearing the
 * screen, retitling the window, or abusing terminal-specific escapes.
 */
export function sanitizeField(value: string): string {
  return value.replace(CONTROL_CHARS_RE, '');
}
