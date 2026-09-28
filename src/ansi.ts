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
