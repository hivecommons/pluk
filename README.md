# @kubestellar/pluk

Pluk structured events from AI agent terminal output.

TypeScript port of [kubestellar/pluk](https://github.com/kubestellar/pluk) — classify, subscribe, and react to JSONL event streams from AI coding agents (Claude Code, GitHub Copilot CLI, Gemini CLI, Goose, etc.).

## Install

```bash
npm install -g @kubestellar/pluk
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
tmux pipe-pane -t my-agent -o "pluk watch my-agent --cli=claude"

# 3. Subscribe to events (another terminal)
pluk subscribe my-agent --filter=state_change,rate_limit,error

# 4. Or start rationguard for real-time detection
rationguard watch my-agent --rebuttal=send

# 5. View the agent
tmux attach -t my-agent
```

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
| `--rationguard` | Start rationguard watcher alongside pluk |
| `--rebuttal=send` | Auto-send rebuttals when rationguard detects excuses |
| `--dangerous` | Skip CLI permission prompts (`--dangerously-skip-permissions` for claude, `--full-auto` for codex, `--non-interactive` for goose) |
| `--dir=/path` | Working directory for the agent |
| `--cli-args="..."` | Extra arguments to pass to the CLI |
| `--no-open` | Don't open a terminal window |
| `--verbose` | Show debug output |

## Programmatic API

```typescript
import { Classifier, getPatterns, subscribe, watch, discoverSessions, attach, send } from '@kubestellar/pluk';

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

## Supported CLIs

Built-in pattern files for: **Claude Code**, **GitHub Copilot CLI**, **Gemini CLI**, **Goose CLI**, **Codex**, **Aider**.

Custom patterns can be loaded from a directory with `--patterns-dir` or `getPatterns(cli, patternsDir)`.

## Works With

- **[@kubestellar/rationguard](https://www.npmjs.com/package/@kubestellar/rationguard)** — real-time rationalization detection and rebuttal
- **[@kubestellar/promptargs](https://www.npmjs.com/package/@kubestellar/promptargs)** — template variable substitution for AI prompts
- **[kubestellar/pluk](https://github.com/kubestellar/pluk)** — the Go binary (this package is the TypeScript port)

## License

Apache-2.0

