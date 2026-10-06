<p align="center">
  <img src="docs/assets/pluk-logo.svg" alt="Pluk" width="120" height="120">
</p>

# Pluk

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pluk classifies, subscribes to, and reacts to JSONL event streams from AI coding agent terminals.

## Install

```bash
npm install -g @hivecommons/pluk
```


## Quick Start

One command to create a tmux session, start an AI CLI, attach pluk event capture, and wire up rationguard for real-time excuse detection:

```bash
pluk attach my-agent --cli=claude --rationguard --rebuttal=send
```

This does four things:
1. Creates a tmux session named `my-agent`
2. Starts `claude` inside it
3. Attaches pluk via `tmux pipe-pane` to classify all terminal output
4. Starts `rationguard watch` to detect rationalizations and send rebuttals back

To just attach pluk without rationguard:

```bash
pluk attach my-agent --cli=claude
```

To attach to an existing tmux session (e.g., one already running goose):

```bash
pluk attach my-agent --cli=goose
```

> **Note:** When attaching to an existing session with `--dangerous`, the CLI may not have permission-skip enabled (the flag only applies when creating a new session). pluk will print a warning with the command to restart the CLI with the right flag.

A new terminal window is always opened for the tmux session (unless `--no-open` is set), so you can interact with the agent directly.

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
# 1. Start an AI agent in tmux
tmux new-session -d -s my-agent
tmux send-keys -t my-agent "claude" Enter

# 2. Attach pluk to capture output
export PLUK_RUN_DIR=/tmp/pluk-run
mkdir -p "$PLUK_RUN_DIR/logs"
tmux pipe-pane -t my-agent "PLUK_RUN_DIR=$PLUK_RUN_DIR pluk watch my-agent --cli=claude >> $PLUK_RUN_DIR/logs/my-agent.jsonl"

# 3. Subscribe to events (another terminal)
export PLUK_RUN_DIR=/tmp/pluk-run
pluk subscribe my-agent --filter=state_change,rate_limit,error

# 4. Or start rationguard for real-time detection
rationguard watch my-agent --rebuttal=send

# 5. View the agent
tmux attach -t my-agent
```

### Environment Variables

| Variable | Default | What it does |
|----------|---------|---------------|
| `PLUK_RUN_DIR` | `/tmp/pluk-run` | Directory for session metadata and JSONL event logs |
| `PLUK_LOG_MAX_BYTES` | `10485760` (10 MiB) | Rotate a session's event log once it exceeds this many bytes |
| `PLUK_LOG_KEEP_LINES` | `5000` | Trailing lines kept in the log across rotation |
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

### Attach Flags

| Flag | What it does |
|------|-------------|
| `--cli=claude` | CLI type: `claude`, `copilot`, `gemini`, `goose`, `codex`, `aider` |
| `--command=<cmd>` | Override the CLI command/executable to launch (instead of the default resolved from `--cli`); combines with `--cli-args` |
| `--rationguard` | Start rationguard watcher alongside pluk (requires `rationguard` on `PATH` — `npm install -g @hivecommons/rationguard` — or `--rationguard-bin`; pluk never fetches it from the registry implicitly) |
| `--rationguard-bin=<cmd>` | Explicit rationguard command to run instead of the one on `PATH`, e.g. `--rationguard-bin='npx --yes @hivecommons/rationguard@0.11.0'` (also `PLUK_RATIONGUARD_BIN`) |
| `--rebuttal=send` | Auto-send rebuttals when rationguard detects excuses |
| `--dangerous` | Skip CLI permission prompts (`--dangerously-skip-permissions` for claude, `--full-auto` for codex, `--non-interactive` for goose) |
| `--dir=/path` | Working directory for the agent |
| `--cli-args="..."` | Extra arguments to pass to the CLI |
| `--no-open` | Don't open a terminal window |
| `--no-raw` | Suppress `raw_output` events from the watcher `attach` starts (on by default for `attach`, unlike plain `pluk watch`, which requires `--include-raw` to emit them) |
| `--verbose` | Show debug output |

### Health diagnostics (`watch`, `subscribe`)

`pluk watch` and `pluk subscribe` deliberately swallow capture-pane failures,
input errors and malformed log lines so the pipe-pane process never dies. To
tell a healthy quiet session from one that is repeatedly failing, add
`--diagnostics[=secs]` (default every 60 s). It writes one JSON line per period,
plus a final one on exit, to **stderr** — stdout stays pure event JSONL:

```json
{"pluk_diagnostics":1,"command":"watch","uptime_s":120,"final":false,"linesSeen":842,"framesPolled":0,"captureFailures":0,"classifyErrors":0,"inputErrors":0,"eventsEmitted":31,"eventsFiltered":4}
```

Only fixed counter categories are reported — never the session name, raw
terminal output or any other user-provided value — and nothing is sent off-box.
The same counters are available programmatically via `watch(...).stats()` and
`Subscriber#stats()`.

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
| `raw_output` | Every non-empty terminal line |
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
| `command_received` | Command sent via pluk-send |

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

Built-in event-classification pattern files exist for: **Claude Code**, **GitHub Copilot CLI**, **Gemini CLI**, **Goose CLI**, **OpenAI Codex CLI**, **Aider**.

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
- **[hivecommons/pluk](https://github.com/hivecommons/pluk)** — the Go binary (this package is the TypeScript port)

## License

Apache-2.0
