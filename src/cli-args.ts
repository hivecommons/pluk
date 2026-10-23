import { ANSI_RED, paintStderr } from './ansi.js';

const VALUE_FLAGS = new Set([
  'text', 'session', 'run-dir', 'cli', 'command', 'cli-args', 'rebuttal',
  'dir', 'rationguard-bin', 'patterns-dir', 'pane', 'filter',
]);

const BOOL_FLAGS = new Set([
  'from-beginning', 'verbose', 'include-raw', 'rationguard', 'no-raw',
  'no-open', 'dangerous', 'json', 'enter', 'literal',
]);

export const COMMAND_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  attach: new Set(['cli', 'command', 'cli-args', 'run-dir', 'rationguard', 'rebuttal', 'no-raw', 'dir', 'no-open', 'verbose', 'dangerous', 'rationguard-bin']),
  sessions: new Set(['run-dir', 'json']),
  subscribe: new Set(['run-dir', 'filter', 'from-beginning', 'verbose', 'diagnostics']),
  watch: new Set(['cli', 'patterns-dir', 'filter', 'include-raw', 'capture', 'pane', 'diagnostics', 'run-dir']),
  send: new Set(['session', 'text', 'enter', 'literal']),
  patterns: new Set(['cli', 'patterns-dir']),
  version: new Set(),
};

// The union is useful for checking the contract, never for authorizing a flag.
export const KNOWN_FLAGS: ReadonlySet<string> = new Set(Object.values(COMMAND_FLAGS).flatMap(flags => [...flags]));

function rejectUnknownFlag(name: string, allowed: ReadonlySet<string>, command: string): void {
  if (!allowed.has(name)) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} unknown flag --${name} for "pluk ${command}" (see pluk ${command} --help)`);
    process.exit(2);
  }
}

export function parseArgs(args: string[], allowed: ReadonlySet<string>, command: string): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const name = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        rejectUnknownFlag(name, allowed, command);
        if (BOOL_FLAGS.has(name) && value !== 'true' && value !== 'false') {
          console.error(`${paintStderr(ANSI_RED, 'Error:')} --${name} is a boolean flag: use --${name} or --${name}=false`);
          process.exit(2);
        }
        flags[name] = value;
      } else {
        const name = arg.slice(2);
        rejectUnknownFlag(name, allowed, command);
        if (VALUE_FLAGS.has(name)) {
          console.error(`${paintStderr(ANSI_RED, 'Error:')} --${name} requires a value: use --${name}=<value>`);
          process.exit(2);
        }
        flags[name] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

