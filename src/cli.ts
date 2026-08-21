#!/usr/bin/env node

import { basename } from 'node:path';
import { Subscriber } from './subscriber.js';
import { watch } from './watch.js';
import { type PlukEventType } from './event.js';
import { listAvailableCLIs, bundledPatternsDir, getPatterns } from './patterns.js';
import { discoverSessions } from './sessions.js';
import { attach } from './attach.js';
import { send } from './send.js';

const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

function usage(): void {
  console.log(`${ANSI_BOLD}pluk${ANSI_RESET} — structured events from AI agent terminal output

${ANSI_CYAN}Usage:${ANSI_RESET}
  pluk attach <session> [--cli=claude] [--rationguard] [--rebuttal=send] [--dangerous] [--verbose]
  pluk sessions [--run-dir=<path>] [--json]
  pluk subscribe <session> [--filter=type1,type2] [--from-beginning] [--verbose]
  pluk watch <session> [--cli=claude] [--filter=type1,type2] [--include-raw] [--capture[=ms]]
  pluk send <session> --text="<text>" [--enter] [--literal]
  pluk patterns [--cli=claude]
  pluk version

${ANSI_CYAN}Commands:${ANSI_RESET}
  attach      Create tmux session, start AI CLI, wire pluk + rationguard
  sessions    List active pluk-monitored sessions
  subscribe   Tail a pluk JSONL log file (from Go binary or other publisher)
  watch       Classify stdin line-by-line, or poll whole tmux frames (--capture)
  send        Send text to a tmux session (inject rebuttals, commands)
  patterns    Show loaded patterns for a CLI
  version     Print version

${ANSI_CYAN}Examples:${ANSI_RESET}
  ${ANSI_DIM}# One command: tmux + claude + pluk + rationguard${ANSI_RESET}
  pluk attach my-agent --cli=claude --rationguard --rebuttal=send

  ${ANSI_DIM}# Just tmux + pluk (no rationguard)${ANSI_RESET}
  pluk attach my-agent --cli=claude

  ${ANSI_DIM}# Attach to existing tmux session${ANSI_RESET}
  pluk attach my-agent --cli=goose --rationguard

  ${ANSI_DIM}# See what's running${ANSI_RESET}
  pluk sessions

  ${ANSI_DIM}# Subscribe to events from a running pluk publisher${ANSI_RESET}
  pluk subscribe my-agent --filter=rate_limit,error,state_change

  ${ANSI_DIM}# Manual: pipe agent output through the classifier${ANSI_RESET}
  tmux pipe-pane -t my-agent -o "pluk watch my-agent --cli=claude >> /tmp/pluk-run/logs/my-agent.jsonl"
`);
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function cmdSubscribe(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const session = positional[0];

  if (!session) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} session name is required`);
    console.error('  pluk subscribe <session>');
    process.exit(1);
  }

  const filter = flags['filter']
    ? flags['filter'].split(',').map(t => t.trim()) as PlukEventType[]
    : undefined;

  const sub = new Subscriber({
    session,
    runDir: flags['run-dir'] ?? process.env['PLUK_RUN_DIR'],
    filter,
    fromBeginning: flags['from-beginning'] === 'true',
    verbose: flags['verbose'] === 'true',
  });

  sub.on('event', event => {
    console.log(JSON.stringify(event));
  });

  sub.on('error', err => {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} ${(err as Error).message}`);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    sub.stop();
    process.exit(0);
  });

  sub.start().catch(err => {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} ${(err as Error).message}`);
    process.exit(1);
  });
}

function cmdWatch(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const session = positional[0] ?? 'stdin';
  const cli = flags['cli'] ?? 'claude';

  const filter = flags['filter']
    ? flags['filter'].split(',').map(t => t.trim()) as PlukEventType[]
    : undefined;

  // Prevent crash on stdout write errors (EPIPE when pipe-pane closes)
  process.stdout.on('error', () => {});
  process.stdin.on('error', () => {});

  const capture = flags['capture'];

  const watcher = watch({
    session,
    cli,
    patternsDir: flags['patterns-dir'],
    filter,
    includeRaw: flags['include-raw'] === 'true',
    mode: capture ? 'capture' : 'stream',
    pane: flags['pane'],
    captureIntervalMs: capture && capture !== 'true' ? Number(capture) : undefined,
    onEvent(event) {
      try {
        console.log(JSON.stringify(event));
      } catch {
        // Swallow write errors to keep pipe-pane alive
      }
    },
  });

  process.on('SIGINT', () => {
    watcher.stop();
    process.exit(0);
  });
}

function cmdAttach(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const session = positional[0];

  if (!session) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} session name is required`);
    console.error('  pluk attach my-agent --cli=claude --rationguard');
    process.exit(1);
  }

  attach({
    session,
    cli: flags['cli'] ?? 'claude',
    cliCommand: flags['command'],
    cliArgs: flags['cli-args'],
    runDir: flags['run-dir'],
    rationguard: flags['rationguard'] === 'true',
    rebuttal: flags['rebuttal'] as 'log' | 'send' | undefined,
    noRaw: flags['no-raw'] === 'true',
    workDir: flags['dir'],
    noOpen: flags['no-open'] === 'true',
    verbose: flags['verbose'] === 'true',
    dangerouslySkipPermissions: flags['dangerous'] === 'true',
  });
}

function cmdSessions(args: string[]): void {
  const { flags } = parseArgs(args);
  const runDir = flags['run-dir'] ?? process.env['PLUK_RUN_DIR'];
  const sessions = discoverSessions(runDir);

  if (flags['json'] === 'true') {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(`${ANSI_DIM}No active pluk sessions found.${ANSI_RESET}`);
    console.log(`${ANSI_DIM}Run dir: ${runDir ?? process.env['PLUK_RUN_DIR'] ?? '/var/run/pluk'}${ANSI_RESET}`);
    return;
  }

  const COL_SESSION = 17;
  const COL_CLI = 10;
  const COL_STATE = 10;
  const COL_TMUX = 6;
  const COL_AGO = 12;

  console.log(
    `${ANSI_BOLD}${'SESSION'.padEnd(COL_SESSION)}${'CLI'.padEnd(COL_CLI)}${'STATE'.padEnd(COL_STATE)}${'TMUX'.padEnd(COL_TMUX)}${'LAST ACTIVITY'.padEnd(COL_AGO)}EVENTS${ANSI_RESET}`,
  );

  for (const s of sessions) {
    const tmuxIcon = s.tmuxAlive ? `${ANSI_GREEN}●${ANSI_RESET}` : `${ANSI_DIM}○${ANSI_RESET}`;
    const stateColor = s.state === 'working' ? ANSI_GREEN : s.state === 'idle' ? ANSI_CYAN : ANSI_DIM;
    console.log(
      `${s.session.padEnd(COL_SESSION)}${s.cli.padEnd(COL_CLI)}${stateColor}${s.state.padEnd(COL_STATE)}${ANSI_RESET}${tmuxIcon}${''.padEnd(COL_TMUX - 2)}${s.lastActivityAgo.padEnd(COL_AGO)}${s.eventCount}`,
    );
  }
}

function cmdPatterns(args: string[]): void {
  const { flags } = parseArgs(args);
  const cli = flags['cli'] ?? 'claude';

  const patterns = getPatterns(cli);
  console.log(`${ANSI_BOLD}Patterns for ${cli}:${ANSI_RESET}\n`);

  const fields: Array<[string, RegExp | null]> = [
    ['idle', patterns.idle],
    ['working', patterns.working],
    ['rateLimit', patterns.rateLimit],
    ['login', patterns.login],
    ['trustDialog', patterns.trustDialog],
    ['bypass', patterns.bypass],
    ['toolStart', patterns.toolStart],
    ['toolEnd', patterns.toolEnd],
    ['error', patterns.error],
    ['model', patterns.model],
    ['sessionEnd', patterns.sessionEnd],
  ];

  for (const [name, re] of fields) {
    const val = re ? `${ANSI_GREEN}${re.source}${ANSI_RESET}` : `${ANSI_DIM}(none)${ANSI_RESET}`;
    console.log(`  ${name.padEnd(14)} ${val}`);
  }

  console.log(`\n${ANSI_DIM}Available CLIs: ${listAvailableCLIs(bundledPatternsDir()).join(', ') || 'claude, copilot, gemini, goose (builtin)'}${ANSI_RESET}`);
}

function cmdSend(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const session = flags['session'] ?? positional[0];
  const text = flags['text'] ?? positional.slice(session === positional[0] ? 1 : 0).join(' ');

  if (!session) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} session name is required`);
    console.error('  pluk send <session> --text="hello"');
    console.error('  pluk-send --session=my-agent --text="hello" --enter');
    process.exit(1);
  }

  if (!text) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} text is required`);
    console.error('  pluk send <session> --text="hello"');
    process.exit(1);
  }

  try {
    send({
      session,
      text,
      enter: flags['enter'] === 'true',
      literal: flags['literal'] === 'true',
    });
  } catch (err) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} failed to send to session "${session}": ${(err as Error).message}`);
    process.exit(1);
  }
}

function main(): void {
  // Prevent uncaught errors from killing the process inside pipe-pane
  process.on('uncaughtException', () => {});
  process.on('unhandledRejection', () => {});

  const bin = basename(process.argv[1] ?? '');
  const args = process.argv.slice(2);

  if (bin === 'pluk-subscribe') {
    cmdSubscribe(args);
    return;
  }
  if (bin === 'pluk-classify') {
    cmdWatch(args);
    return;
  }
  if (bin === 'pluk-send') {
    cmdSend(args);
    return;
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case 'attach':
      cmdAttach(rest);
      break;
    case 'sessions':
    case 'ls':
      cmdSessions(rest);
      break;
    case 'subscribe':
      cmdSubscribe(rest);
      break;
    case 'watch':
    case 'classify':
      cmdWatch(rest);
      break;
    case 'send':
      cmdSend(rest);
      break;
    case 'patterns':
      cmdPatterns(rest);
      break;
    case 'version':
      console.log('@kubestellar/pluk 0.1.0');
      break;
    case '--help':
    case '-h':
    case undefined:
      usage();
      break;
    default:
      console.error(`${ANSI_RED}Unknown command:${ANSI_RESET} ${command}`);
      usage();
      process.exit(1);
  }
}

main();
