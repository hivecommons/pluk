<p align="center">
  <img src="docs/assets/pluk-logo.svg" alt="Pluk" width="120" height="120">
</p>

# Pluk

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pluk classifies, subscribes to, and reacts to JSONL event streams from AI coding agent terminals.

## Install

Requirements:

- Node.js 22 or newer
- tmux (`attach`, `send` and `watch --capture` drive tmux sessions)

```bash
npm install -g @hivecommons/pluk
```

Optional: install [rationguard](https://www.npmjs.com/package/@hivecommons/rationguard) only if you want `pluk attach --rationguard`. pluk never fetches it for you; without it on `PATH` (or `--rationguard-bin`), `--rationguard` exits with an error.

```bash
npm install -g @hivecommons/rationguard
```

## Quick Start

One command to create a tmux session, start an AI CLI, and attach pluk event capture:

```bash
pluk attach my-agent --cli=claude
```

This does three things:
1. Creates a tmux session named `my-agent`
2. Attaches pluk via `tmux pipe-pane` to classify all terminal output, including start-up output
3. Starts `claude` inside it

To also wire up rationguard for real-time excuse detection (requires rationguard to be installed; see [Install](#install)):

```bash
pluk attach my-agent --cli=claude --rationguard --rebuttal=send
```

This additionally starts `rationguard watch` to detect rationalizations and send rebuttals back.

To attach to an existing tmux session (e.g., one already running goose):

```bash
pluk attach my-agent --cli=goose
```

> **Note:** When attaching to an existing session with `--dangerous`, the CLI may not have permission-skip enabled (the flag only applies when creating a new session). pluk will print a warning with the command to restart the CLI with the right flag. Likewise, `--command`, `--cli-args` and `--dir` only apply when creating a new session; pluk warns when they are passed to an existing one.

By default, pluk attaches to the tmux session. Without `--rationguard`, it attaches in the current terminal. With `--rationguard` on macOS (iTerm2 / Terminal.app), it opens a new terminal window; elsewhere it prints a `tmux attach -t <session>` hint, since rationguard runs in the foreground. Use `--no-open` to suppress this: without `--rationguard` the session is left detached and the attach hint is printed instead; with `--rationguard` it suppresses the new window (macOS) or the hint (elsewhere).

## See What's Running

```bash
pluk sessions
```

```
SESSION          CLI       STATE     TMUX  LAST ACTIVITY EVENTS
scanner          claude    working   ●     2s ago        1204
helper           claude    idle      ●     45s ago       892
goose-exp        goose     idle      ○     3m ago        156
```

## Manual Setup

If you prefer to wire things up yourself:

```bash
# 1. Create a tmux session (don't start the CLI yet)
tmux new-session -d -s my-agent

# 2. Attach pluk to capture output before the CLI starts, so start-up
#    output (trust prompts, login, model banner) is classified too
export PLUK_RUN_DIR=/tmp/pluk-run
mkdir -p "$PLUK_RUN_DIR/logs"
tmux pipe-pane -t my-agent "PLUK_RUN_DIR=$PLUK_RUN_DIR pluk watch my-agent --cli=claude >> $PLUK_RUN_DIR/logs/my-agent.jsonl"

# 3. Start the AI agent inside the session
tmux send-keys -t my-agent "claude" Enter

# 4. Subscribe to events (another terminal)
export PLUK_RUN_DIR=/tmp/pluk-run
pluk subscribe my-agent --filter=state_change,rate_limit,error

# 5. Or start rationguard for real-time detection
rationguard watch my-agent --rebuttal=send

# 6. View the agent
tmux attach -t my-agent
```

### Environment Variables

| Variable | Default | What it does |
|----------|---------|---------------|
| `PLUK_RUN_DIR` | `$XDG_RUNTIME_DIR/pluk`, else `<tmpdir>/pluk-<uid>` | Directory for session metadata and JSONL event logs |
| `PLUK_LOG_MAX_BYTES` | `10485760` (10 MiB) | Byte cap for a session's event log: once exceeded, the log is trimmed to the newest lines that fit under it |
| `PLUK_LOG_KEEP_LINES` | `5000` | Keep up to this many trailing lines across rotation, within the `PLUK_LOG_MAX_BYTES` cap |
| `PLUK_RATIONGUARD_BIN` | *(unset)* | Rationguard command for `pluk attach --rationguard` when it is not on `PATH`; same as `--rationguard-bin` |

## CLI Commands

| Command | What it does |
|---------|-------------|
| `pluk attach <session>` | Create tmux + start CLI + wire pluk (+ rationguard) |
| `pluk sessions` | List active pluk-monitored sessions |
| `pluk subscribe <session>` | Tail a pluk JSONL log (like `tail -f`) |
| `pluk watch <session>` | Classify stdin line-by-line |
| `pluk send <session> --text="..." --enter` | Send text to a tmux session |
| `pluk patterns --cli=claude` | Show loaded patterns for a CLI |
| `pluk version` | Print the installed version |
| `pluk <command> --help` / `-h` | Show usage (works after any subcommand) |

Unknown, misspelled, or wrong-subcommand `--flags` exit 2 (`unknown flag --name for "pluk <cmd>" (see pluk <cmd> --help)`) instead of being silently ignored. For example, `pluk sessions --cli=claude` is rejected: `--cli` belongs to `attach`, `watch`, and `patterns`, not `sessions`. Run `pluk --help` for the per-command flag lists.

### Attach Flags

| Flag | What it does |
|------|-------------|
| `--cli=claude` | CLI type: `claude`, `copilot`, `gemini`, `goose`, `codex`, `aider`, `omp` |
| `--command=<cmd>` | Override the CLI command/executable to launch (instead of the default resolved from `--cli`); combines with `--cli-args` |
| `--rationguard` | Start rationguard watcher alongside pluk (requires `rationguard` on `PATH` — `npm install -g @hivecommons/rationguard` — or `--rationguard-bin`; pluk never fetches it from the registry implicitly) |
| `--rationguard-bin=<cmd>` | Explicit rationguard command to run instead of the one on `PATH`, e.g. `--rationguard-bin='npx --yes @hivecommons/rationguard@0.13.0'` (also `PLUK_RATIONGUARD_BIN`); the flag is ignored with a warning without `--rationguard` |
| `--rebuttal=log\|send` | Log rebuttals or auto-send them when rationguard detects excuses; other values exit with code 2 before attaching. Ignored with a warning without `--rationguard` |
| `--dangerous` | Skip CLI permission prompts (`--dangerously-skip-permissions` for claude, `--allow-all-tools` for copilot, `--full-auto` for codex, `GOOSE_MODE=auto` for goose, `--approval-mode yolo` for omp, `--yolo` for gemini, `--yes-always` for aider) |
| `--dir=/path` | Working directory for the agent |
| `--cli-args="..."` | Extra arguments to pass to the CLI |
| `--no-open` | Don't attach: without `--rationguard`, leave the session detached and print the attach hint; with `--rationguard`, don't open a new window (macOS) or print the hint (elsewhere) |
| `--no-raw` | Suppress `raw_output` events from the watcher `attach` starts (on by default for `attach`, unlike plain `pluk watch`, which requires `--include-raw` to emit them) |
| `--verbose` | Show debug output |

### Watch, Subscribe and Sessions Flags

| Command | Flag | What it does |
|---------|------|-------------|
| `watch` | `--cli=claude` | CLI whose patterns classify the output; if no pattern set exists for the name (and none in `--patterns-dir`), pluk warns once on stderr and emits only `raw_output` (exit 0). `pluk patterns --cli=<name>` reports `no pattern set for <name>` and lists the available names |
| `watch` | `--filter=type1,type2` | Emit only the listed event types (also accepted by `subscribe`); unknown or empty entries exit 2 |
| `watch` | `--include-raw` | Also emit `raw_output` events |
| `watch` | `--capture[=ms]` | Instead of reading stdin, poll `tmux capture-pane` and classify each whole rendered frame; useful for TUIs whose pipe-pane stream has no line feeds. Interval in milliseconds (positive integer), default `1000`. With `--include-raw`, `raw_output` `data.line` is a whole ANSI-stripped screen |
| `watch` | `--pane=<target>` | tmux pane to poll in `--capture` mode (defaults to the session name) |
| `watch` | `--patterns-dir=<dir>` | Load pattern files from this directory |
| `patterns` | `--patterns-dir=<dir>` | Show the patterns loaded from this directory (same lookup as `watch`) |
| `subscribe` | `--from-beginning` | Replay the existing log from the start instead of only new lines |
| `subscribe` | `--verbose` | Show debug output |
| `sessions`, `subscribe`, `watch` | `--run-dir=<path>` | Run directory to use (overrides `PLUK_RUN_DIR`); `attach` accepts it too |
| `sessions` | `--json` | Print the session list as JSON instead of a table |

### Health diagnostics (`watch`, `subscribe`)

`pluk watch` and `pluk subscribe` deliberately swallow capture-pane failures,
input errors and malformed log lines so the pipe-pane process never dies. To
tell a healthy quiet session from one that is repeatedly failing, add
`--diagnostics[=secs]` (default every 60 s); the value must be a positive number
of seconds (at most 2147483, the `setInterval` limit), or omitted to use the
default—anything else is rejected with exit 2.
It writes one JSON line per period, plus a final one on exit, to **stderr** —
stdout stays pure event JSONL:

```json
{"pluk_diagnostics":1,"command":"watch","uptime_s":120,"final":false,"linesSeen":842,"framesPolled":0,"captureFailures":0,"classifyErrors":0,"inputErrors":0,"eventsEmitted":31,"eventsFiltered":4}
```

Only fixed counter categories are reported — never the session name, raw
terminal output or any other user-provided value — and nothing is sent off-box.
The same counters are available programmatically via `watch(...).stats()` and
`Subscriber#stats()`. Library callers of `startDiagnostics` that pass a finite
period above 2147483.647 seconds (about 24.9 days) have it capped at that value
to stay within Node's timer limit; the CLI rejects out-of-range values as
described above.

## Programmatic API

```typescript
import { Classifier, getPatterns, subscribe, watch, discoverSessions, attach, send } from '@hivecommons/pluk';

// One-command setup: tmux + CLI + pluk + rationguard
attach({
  session: 'my-agent',
  cli: 'claude',
  rationguard: true,
  rebuttal: 'send',
  dangerouslySkipPermissions: true,
});

// Send text to a tmux session
send({ session: 'my-agent', text: 'check the build', enter: true });

// Discover running sessions
const sessions = discoverSessions('/tmp/pluk-run');
for (const s of sessions) {
  console.log(`${s.session}: ${s.cli} (${s.state}, ${s.lastActivityAgo})`);
}

// Classify individual lines
const patterns = getPatterns('claude');
const classifier = new Classifier({ session: 'my-agent', patterns });
const event = classifier.classify('● Read main.go');
// → { type: 'tool_call_started', data: { tool: 'Read', ... } }

// Subscribe to a JSONL log file (tail -f behavior)
const sub = subscribe('my-agent', (event) => {
  console.log(event.type, event.data);
}, { filter: ['rate_limit', 'error'] });

// Watch stdin for events
const watcher = watch({
  session: 'my-agent',
  cli: 'claude',
  onEvent(event) {
    if (event.type === 'rate_limit') {
      console.warn('Rate limited!', event.data.message);
    }
  },
});
```

## Event Types

| Type | Meaning |
|------|---------|
| `raw_output` | Every non-empty terminal line (in `--capture` mode, each changed ANSI-stripped screen) |
| `state_change` | Agent went idle or started working |
| `rate_limit` | Usage limit / quota exhausted |
| `login_required` | Authentication needed |
| `trust_dialog` | Folder trust prompt |
| `bypass_permissions` | Permission bypass prompt |
| `tool_call_started` | Agent invoked a tool |
| `tool_call_completed` | Tool finished |
| `error` | Error in output |
| `model_changed` | Model was switched |
| `session_ended` | CLI session ended |
| `command_received` | Reserved; not currently emitted by `pluk send` / `pluk-send` |

## Event Schema

The JSONL event stream is pluk's stable telemetry surface. `pluk watch` and `pluk subscribe` write one JSON object per line to **stdout**; diagnostic and human-readable output (`pluk attach` progress and warnings, errors, `--diagnostics`) goes to **stderr**.

| Field | Type | Meaning |
|-------|------|---------|
| `v` | number | Schema version (currently `1`); changes only on a breaking envelope change |
| `ts` | string | UTC ISO-8601 timestamp with millisecond precision |
| `seq` | number | Per-process sequence number |
| `pid` | number | Process ID of the emitter |
| `session` | string | Session name |
| `pane` | string | tmux pane the event came from |
| `source` | string | Emitting component |
| `type` | string | One of the event types below |
| `data` | object | String-to-string map with event-specific details |

```json
{"v":1,"ts":"2026-01-01T00:00:00.000Z","seq":1,"pid":4242,"session":"my-agent","pane":"my-agent","source":"pluk","type":"state_change","data":{"to":"idle"}}
```

Existing fields and event types are not renamed or removed within a schema version; new event types and new `data` keys may be added, so consumers should ignore what they do not recognise. Counting events per `type` yields metrics such as classifier hits.

## Send Command

Inject text into a running tmux session — used by rationguard to send rebuttals, or by you to send commands:

```bash
# Send text and press Enter
pluk send my-agent --text="check the build logs" --enter

# Send literal text (no key interpretation)
pluk send my-agent --text="hello world" --literal

# Also available as a standalone binary
pluk-send --session=my-agent --text="test" --enter
```

## Standalone Binaries

In addition to the `pluk <command>` subcommand form, three standalone binaries are installed alongside `pluk` and behave the same as their subcommand equivalents:

| Binary | Equivalent to |
|--------|---------------|
| `pluk-subscribe` | `pluk subscribe` |
| `pluk-classify` | `pluk watch` |
| `pluk-send` | `pluk send` |

## Supported CLIs

Built-in event-classification pattern files exist for: **Claude Code**, **GitHub Copilot CLI**, **Gemini CLI**, **Goose CLI**, **OpenAI Codex CLI**, **Aider**, **Oh My Pi (`omp`)**.

Custom patterns can be loaded from a directory with `--patterns-dir` or `getPatterns(cli, patternsDir)`.

### Pattern File Format

A pattern file is named `<cli>.patterns` (e.g. `codex.patterns`) and placed in
the directory passed to `--patterns-dir`. Each non-blank, non-comment line is
`KEY='regex'` — single or double quotes are both accepted, `#` starts a
comment, and blank lines are ignored. Every value is compiled as a JavaScript
`RegExp` source string, so use `|` for alternation (as in the bundled files
below). A key that is omitted, empty, or fails to compile is simply disabled
(treated as `null`) rather than raising an error.

Recognized keys:

| Key | Meaning |
|-----|---------|
| `IDLE_PATTERN` | Terminal is at rest / showing a prompt |
| `WORKING_PATTERNS` | Agent is actively working (spinner, status hint) |
| `RATE_LIMIT_PATTERN` | Usage limit / quota exhausted |
| `LOGIN_PATTERN` | Authentication required |
| `TRUST_DIALOG_PATTERN` | Folder trust prompt |
| `BYPASS_PATTERN` | Permission-bypass prompt |
| `TOOL_START_PATTERN` | A tool call started |
| `TOOL_END_PATTERN` | A tool call completed |
| `ERROR_PATTERN` | Error in output |
| `MODEL_PATTERN` | Model was switched |
| `SESSION_END_PATTERN` | CLI session ended |

Minimal example (`codex.patterns`):

```
# codex.patterns — minimal custom pattern file
IDLE_PATTERN='^\$ $'
WORKING_PATTERNS='Thinking|Generating'
ERROR_PATTERN='^\s*Error:|^\s*FATAL'
```

See `patterns/*.patterns` in this repo for complete, real-world examples.

## Works With

- **[@hivecommons/rationguard](https://www.npmjs.com/package/@hivecommons/rationguard)** — real-time rationalization detection and rebuttal
- **[@hivecommons/promptargs](https://www.npmjs.com/package/@hivecommons/promptargs)** — template variable substitution for AI prompts

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers local setup, tests, and how to add or fix a CLI pattern set. If an agent CLI's output is misclassified, or you want pluk to support a new CLI, open a [pattern request](https://github.com/hivecommons/pluk/issues/new?template=pattern_request.yml). For questions, join the [Hive Commons Discord](https://hivecommons.dev/discord).

## License

Apache-2.0
