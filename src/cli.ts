#!/usr/bin/env node

import { basename, join } from 'node:path';
import { Subscriber } from './subscriber.js';
import { watch } from './watch.js';
import { startDiagnostics, log } from './diagnostics.js';
import { PLUK_EVENT_TYPES, type PlukEventType } from './event.js';
import { listAvailableCLIs, bundledPatternsDir, getPatterns, hasAnyPattern, BUILTIN_PATTERNS } from './patterns.js';
import { discoverSessions } from './sessions.js';
import { resolveRunDir, rotateLogFileIfNeeded, validateSessionName } from './run-dir.js';
import { attach } from './attach.js';
import { send } from './send.js';
import { ANSI_RED, ANSI_GREEN, ANSI_CYAN, ANSI_DIM, ANSI_BOLD, ANSI_RESET, paintStderr, paintStdout } from './ansi.js';
import { packageVersion } from './version.js';

/** How often a running `pluk watch` checks its log file for rotation. */
const LOG_ROTATE_CHECK_INTERVAL_MS = 30_000;

function usage(): void {
  console.log(`${paintStdout(ANSI_BOLD, 'pluk')} — structured events from AI agent terminal output

${paintStdout(ANSI_CYAN, 'Usage:')}
  pluk attach <session> [--cli=claude] [--rationguard] [--rationguard-bin=<cmd>] [--rebuttal=send] [--dangerous] [--verbose]
  pluk sessions [--run-dir=<path>] [--json]
  pluk subscribe <session> [--filter=type1,type2] [--from-beginning] [--verbose] [--diagnostics[=secs]]
  pluk watch <session> [--cli=claude] [--filter=type1,type2] [--include-raw] [--capture[=ms]] [--diagnostics[=secs]]
  pluk send <session> --text="<text>" [--enter] [--literal]
  pluk patterns [--cli=claude] [--patterns-dir=<dir>]
  pluk version

${paintStdout(ANSI_CYAN, 'Commands:')}
  attach      Create tmux session, start AI CLI, wire pluk + rationguard
  sessions    List active pluk-monitored sessions
  subscribe   Tail a pluk JSONL log file (from pluk watch or any other publisher)
  watch       Classify stdin line-by-line, or poll whole tmux frames (--capture)
  send        Send text to a tmux session (inject rebuttals, commands)
  patterns    Show loaded patterns for a CLI
  version     Print version
  --help, -h  Show this usage (also works after a subcommand)

${paintStdout(ANSI_CYAN, 'Examples:')}
  ${paintStdout(ANSI_DIM, '# One command: tmux + claude + pluk + rationguard')}
  pluk attach my-agent --cli=claude --rationguard --rebuttal=send

  ${paintStdout(ANSI_DIM, '# Just tmux + pluk (no rationguard)')}
  pluk attach my-agent --cli=claude

  ${paintStdout(ANSI_DIM, '# Attach to existing tmux session')}
  pluk attach my-agent --cli=goose --rationguard

  ${paintStdout(ANSI_DIM, "# See what's running")}
  pluk sessions

  ${paintStdout(ANSI_DIM, '# Subscribe to events from a running pluk publisher')}
  pluk subscribe my-agent --filter=rate_limit,error,state_change

  ${paintStdout(ANSI_DIM, '# Manual: pipe agent output through the classifier')}
  tmux pipe-pane -t my-agent -o "pluk watch my-agent --cli=claude >> \\"\\$XDG_RUNTIME_DIR/pluk/logs/my-agent.jsonl\\""
`);
}

const VALUE_FLAGS = new Set([
  'text', 'session', 'run-dir', 'cli', 'command', 'cli-args', 'rebuttal',
  'dir', 'rationguard-bin', 'patterns-dir', 'pane', 'filter',
]);

const BOOL_FLAGS = new Set([
  'from-beginning', 'verbose', 'include-raw', 'rationguard', 'no-raw',
  'no-open', 'dangerous', 'json', 'enter', 'literal',
]);

const KNOWN_FLAGS = new Set([
  'help', ...VALUE_FLAGS, ...BOOL_FLAGS, 'capture', 'diagnostics',
]);

function rejectUnknownFlag(name: string): void {
  if (!KNOWN_FLAGS.has(name)) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} unknown flag --${name} (see pluk --help)`);
    process.exit(2);
  }
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const name = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        rejectUnknownFlag(name);
        if (BOOL_FLAGS.has(name) && value !== 'true' && value !== 'false') {
          console.error(`${paintStderr(ANSI_RED, 'Error:')} --${name} is a boolean flag: use --${name} or --${name}=false`);
          process.exit(2);
        }
        flags[name] = value;
      } else {
        const name = arg.slice(2);
        rejectUnknownFlag(name);
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

function installPipePaneErrorHandlers(): void {
  process.on('uncaughtException', () => {});
  process.on('unhandledRejection', () => {});
}

function parseFilter(raw: string | undefined): PlukEventType[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === '') {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} --filter requires at least one event type (valid: ${PLUK_EVENT_TYPES.join(', ')})`);
    process.exit(2);
  }
  const types = raw.split(',').map(t => t.trim());
  for (const t of types) {
    if (!(PLUK_EVENT_TYPES as readonly string[]).includes(t)) {
      console.error(`${paintStderr(ANSI_RED, 'Error:')} unknown event type "${t}" (valid: ${PLUK_EVENT_TYPES.join(', ')})`);
      process.exit(2);
    }
  }
  return types as PlukEventType[];
}

// setInterval() stores its delay as a signed 32-bit int; larger values are
// clamped to 1 ms with a TimeoutOverflowWarning, so reject them up front.
const MAX_DIAGNOSTICS_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

function parseDiagnosticsFlag(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === 'true') return raw;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} --diagnostics expects a positive number of seconds (or a bare --diagnostics for the 60s default)`);
    process.exit(2);
  }
  if (seconds > MAX_DIAGNOSTICS_SECONDS) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} --diagnostics must be at most ${MAX_DIAGNOSTICS_SECONDS} seconds`);
    process.exit(2);
  }
  return raw;
}

function cmdSubscribe(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const session = positional[0];

  if (!session) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} session name is required`);
    console.error('  pluk subscribe <session>');
    process.exit(1);
  }

  const filter = parseFilter(flags['filter']);
  const diagnosticsFlag = parseDiagnosticsFlag(flags['diagnostics']);

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

  const stopDiagnostics = startDiagnostics('subscribe', () => ({ ...sub.stats() }), diagnosticsFlag);

  sub.on('error', err => {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} ${(err as Error).message}`);
    stopDiagnostics();
    process.exit(1);
  });

  process.on('SIGINT', () => {
    sub.stop();
    stopDiagnostics();
    process.exit(0);
  });

  sub.start().catch(err => {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} ${(err as Error).message}`);
    process.exit(1);
  });
}

function cmdWatch(args: string[]): void {
  installPipePaneErrorHandlers();

  const { positional, flags } = parseArgs(args);
  const session = positional[0] ?? 'stdin';
  const cli = flags['cli'] ?? 'claude';

  const filter = parseFilter(flags['filter']);
  const diagnosticsFlag = parseDiagnosticsFlag(flags['diagnostics']);

  const noPatternSet = !hasAnyPattern(getPatterns(cli, flags['patterns-dir']));
  if (noPatternSet) {
    log('info', `no pattern set for --cli=${cli} (bundled: ${listAvailableCLIs(bundledPatternsDir()).join(', ') || builtinCLIList()}); only raw_output will be emitted`);
  }

  // Prevent crash on stdout write errors (EPIPE when pipe-pane closes)
  process.stdout.on('error', () => {});
  process.stdin.on('error', () => {});

  const capture = flags['capture'];
  let captureIntervalMs: number | undefined;
  if (flags['pane'] !== undefined && !capture) {
    console.error('Warning: --pane is ignored without --capture');
  }
  if (capture !== undefined && capture !== 'true') {
    captureIntervalMs = Number(capture);
    if (!Number.isInteger(captureIntervalMs) || captureIntervalMs <= 0) {
      console.error(`${paintStderr(ANSI_RED, 'Error:')} --capture expects a positive integer number of milliseconds`);
      process.exit(2);
    }
  }

  const watcher = watch({
    session,
    cli,
    patternsDir: flags['patterns-dir'],
    filter,
    includeRaw: flags['include-raw'] === 'true' || noPatternSet,
    mode: capture ? 'capture' : 'stream',
    pane: flags['pane'],
    captureIntervalMs,
    onEvent(event) {
      try {
        console.log(JSON.stringify(event));
      } catch {
        // Swallow write errors to keep pipe-pane alive
      }
    },
  });

  // `pluk watch` is the one process alive for the whole tmux pipe-pane
  // session; the JSONL log itself is appended by the shell's `>>`
  // redirection, so this is the only place that can bound its growth for a
  // long-running session. Guard the session name the same way `attach`
  // does before deriving a log path from it.
  try {
    validateSessionName(session);
    const logFile = join(resolveRunDir(flags['run-dir']), 'logs', `${session}.jsonl`);
    const rotateInterval = setInterval(() => {
      try {
        rotateLogFileIfNeeded(logFile);
      } catch {
        // Never let rotation crash pipe-pane
      }
    }, LOG_ROTATE_CHECK_INTERVAL_MS);
    rotateInterval.unref();

    process.on('exit', () => clearInterval(rotateInterval));
  } catch {
    // Unsafe/placeholder session name (e.g. the default "stdin") — skip
    // rotation rather than derive a log path from it.
  }

  const stopDiagnostics = startDiagnostics('watch', () => ({ ...watcher.stats() }), diagnosticsFlag);
  process.on('exit', stopDiagnostics);

  process.on('SIGINT', () => {
    watcher.stop();
    stopDiagnostics();
    process.exit(0);
  });
}

function cmdAttach(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const session = positional[0];

  if (!session) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} session name is required`);
    console.error('  pluk attach my-agent --cli=claude --rationguard');
    process.exit(1);
  }

  const rebuttal = flags['rebuttal'];
  if (rebuttal !== undefined && rebuttal !== 'log' && rebuttal !== 'send') {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} --rebuttal must be one of: log, send`);
    process.exit(2);
  }

  if (flags['rationguard'] !== 'true') {
    for (const flag of ['rebuttal', 'rationguard-bin']) {
      if (flags[flag] !== undefined) {
        console.error(`Warning: --${flag} is ignored without --rationguard`);
      }
    }
  }

  attach({
    session,
    cli: flags['cli'] ?? 'claude',
    cliCommand: flags['command'],
    cliArgs: flags['cli-args'],
    runDir: flags['run-dir'],
    rationguard: flags['rationguard'] === 'true',
    rebuttal,
    noRaw: flags['no-raw'] === 'true',
    workDir: flags['dir'],
    noOpen: flags['no-open'] === 'true',
    verbose: flags['verbose'] === 'true',
    dangerouslySkipPermissions: flags['dangerous'] === 'true',
    rationguardBin: flags['rationguard-bin'],
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
    console.log(paintStdout(ANSI_DIM, 'No active pluk sessions found.'));
    console.log(paintStdout(ANSI_DIM, `Run dir: ${runDir ?? resolveRunDir()}`));
    return;
  }

  const COL_SESSION = 17;
  const COL_CLI = 10;
  const COL_STATE = 10;
  const COL_TMUX = 6;
  const COL_AGO = 14;

  console.log(
    paintStdout(
      ANSI_BOLD,
      `${'SESSION'.padEnd(COL_SESSION)}${'CLI'.padEnd(COL_CLI)}${'STATE'.padEnd(COL_STATE)}${'TMUX'.padEnd(COL_TMUX)}${'LAST ACTIVITY'.padEnd(COL_AGO)}EVENTS`,
    ),
  );

  for (const s of sessions) {
    const tmuxIcon = s.tmuxAlive ? paintStdout(ANSI_GREEN, '●') : paintStdout(ANSI_DIM, '○');
    const stateColor = s.state === 'working' ? ANSI_GREEN : s.state === 'idle' ? ANSI_CYAN : ANSI_DIM;
    console.log(
      `${s.session.padEnd(COL_SESSION)}${s.cli.padEnd(COL_CLI)}${paintStdout(stateColor, s.state.padEnd(COL_STATE))}${tmuxIcon}${''.padEnd(COL_TMUX - 1)}${s.lastActivityAgo.padEnd(COL_AGO)}${s.eventCount}`,
    );
  }
}

function builtinCLIList(): string {
  return `${Object.keys(BUILTIN_PATTERNS).join(', ')} (builtin)`;
}

function cmdPatterns(args: string[]): void {
  const { flags } = parseArgs(args);
  const cli = flags['cli'] ?? 'claude';

  const patternsDir = flags['patterns-dir'];
  const patterns = getPatterns(cli, patternsDir);
  const names = [
    ...(patternsDir ? listAvailableCLIs(patternsDir) : []),
    ...listAvailableCLIs(bundledPatternsDir()),
  ];
  const available = [...new Set(names)].join(', ') || builtinCLIList();
  if (!hasAnyPattern(patterns)) {
    log('info', `no pattern set for ${cli}; available CLIs: ${available}`);
  }
  console.log(`${paintStdout(ANSI_BOLD, `Patterns for ${cli}:`)}\n`);

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
    const val = re ? paintStdout(ANSI_GREEN, re.source) : paintStdout(ANSI_DIM, '(none)');
    console.log(`  ${name.padEnd(14)} ${val}`);
  }

  console.log(`\n${paintStdout(ANSI_DIM, `Available CLIs: ${available}`)}`);
}

function cmdSend(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  // The leading positional is the session only when --session was not given;
  // deciding by value would drop a text word that happens to equal the name.
  const sessionFromFlag = flags['session'] !== undefined;
  const session = sessionFromFlag ? flags['session'] : positional[0];
  const text = flags['text'] ?? positional.slice(sessionFromFlag ? 0 : 1).join(' ');

  if (!session) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} session name is required`);
    console.error('  pluk send <session> --text="hello"');
    console.error('  pluk-send --session=my-agent --text="hello" --enter');
    process.exit(1);
  }

  if (!text) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} text is required`);
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
    console.error(`${paintStderr(ANSI_RED, 'Error:')} failed to send to session "${session}": ${(err as Error).message}`);
    process.exit(1);
  }
}

// Dedicated bin names are pinned to one subcommand; the generic `pluk` bin
// reads it from argv. Keep this the only place that mapping lives.
const BIN_COMMANDS: Record<string, string> = {
  'pluk-send': 'send',
  'pluk-subscribe': 'subscribe',
  'pluk-classify': 'classify',
};

function resolveCommand(bin: string, args: string[]): { command: string | undefined; rest: string[] } {
  const pinned = BIN_COMMANDS[bin];
  return pinned !== undefined
    ? { command: pinned, rest: args }
    : { command: args[0], rest: args.slice(1) };
}

// `--help` is always a flag to parseArgs, but `-h` is a positional, so inside
// `send` it is message text once the session is known — either from the
// leading positional or from `--session=` (mirrors cmdSend's split).
function wantsHelp(command: string | undefined, rest: string[]): boolean {
  if (command === '--help' || command === '-h') return true;
  const isSend = command === 'send';
  let sessionKnown = isSend && rest.some((arg) => arg.startsWith('--session='));
  for (const arg of rest) {
    if (arg === '--help') return true;
    if (arg === '-h' && !sessionKnown) return true;
    if (isSend && !arg.startsWith('--')) sessionKnown = true;
  }
  return false;
}

function main(): void {
  const bin = basename(process.argv[1] ?? '');
  const args = process.argv.slice(2);
  const { command, rest } = resolveCommand(bin, args);

  if (wantsHelp(command, rest)) {
    usage();
    return;
  }

  try {
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
        console.log(`@hivecommons/pluk ${packageVersion()}`);
        break;
      case undefined:
        usage();
        break;
      default:
        console.error(`${paintStderr(ANSI_RED, 'Unknown command:')} ${command}`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`${paintStderr(ANSI_RED, 'Error:')} ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
