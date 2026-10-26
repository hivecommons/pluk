# Changelog

All notable changes to this project are documented in this file.

## 0.11.0 - 2026-10-26

### Breaking: stricter CLI parsing

Scripts relying on input silently accepted by 0.10.0 must correct it before upgrading. The following now exit with code 2:

- Unknown or misspelled `--flags`, such as `--captur=50` (#346).
- Flags belonging to another subcommand, such as `send --capture=50` (#348).
- Boolean flags with values other than `true` or `false`, such as `--enter=1`; use `--enter=false` to disable a flag (#338).
- Invalid `--diagnostics` intervals, including non-numeric, non-positive, `false`, and values above 2147483 seconds (#342).

### Added

- Added a bundled `omp` (Oh My Pi) pattern set for `pluk watch --cli=omp`.
- `pluk watch` now warns once on stderr when the `--cli` name has no pattern set, and `pluk patterns --cli=<name>` reports `no pattern set` instead of printing an empty set.

### Changed

- `pluk attach` now writes its progress, warnings and status messages to stderr, and the JSONL event schema is documented in the README as a stable surface.
- Releases publish to npm via Trusted Publishing (OIDC) through the `npm` GitHub Environment; the `NPM_TOKEN` secret is no longer used (#303).

### Fixed

- Diagnostics written to stderr no longer carry ANSI colour codes unless stderr is a TTY and `NO_COLOR` is unset; a small leveled `log()` helper is added in `src/diagnostics.ts`.
- `pluk sessions` no longer reports STATE/CLI as unknown when `raw_output` events (from `pluk attach` with raw capture) flood the log tail; raw lines are skipped when sizing the tail window.
- `pluk patterns` and `pluk subscribe` now derive the builtin CLI fallback list from `BUILTIN_PATTERNS`, so it includes codex and aider and cannot drift.
- `pluk subscribe` and `pluk watch` now reject an empty `--filter=` value with an error (exit 2) instead of silently ignoring it.
- `pluk watch` now emits `raw_output` events when no pattern set exists for the chosen `--cli`, as its warning promises, without needing `--include-raw`.
- Log rotation now also enforces `PLUK_LOG_MAX_BYTES`: after trimming to `PLUK_LOG_KEEP_LINES`, the oldest kept lines are dropped until the log fits under the byte cap, so it no longer stays over the cap and gets rewritten every 30s.
- `pluk patterns` now honors `--patterns-dir`, so a custom pattern set is shown (and its CLI names listed) instead of a false "no pattern set".
- `tool_call_started` events no longer cut an emoji or other astral character in half at the 120-character `input_preview` limit; truncation now counts code points, so the preview never ends in an invalid lone surrogate.
- `tool_call_started` events no longer cut a ZWJ emoji sequence, flag or base-plus-combining-mark character in half at the 120-character `input_preview` limit; truncation now counts grapheme clusters.
- `pluk sessions` no longer shows `NaNd ago` (or sorts a session first) when a log event carries an unparseable `ts`; such timestamps are ignored for last activity.
- `pluk attach` no longer word-splits `pluk`/`rationguard` paths resolved from `PATH` when they contain spaces; the resolved path is shell-quoted so the pipe-pane, rationguard spawn, and watcher cleanup pattern see a single word (#274).
- Bare value-taking flags (e.g. `pluk send s --text hello`, `--run-dir /tmp/x`, `--filter x`) are now rejected with exit code 2 and a `--flag=<value>` hint instead of being parsed as the string `true` (which typed `true` into the agent pane); fixes #278.
- Log rotation now applies the `PLUK_LOG_MAX_BYTES` cap even when the log has fewer than `PLUK_LOG_KEEP_LINES` lines (#283).
- `pluk watch --capture=<ms>` now rejects fractional intervals such as `--capture=1.5`, accepting only positive integers as documented (#291).
- `tool_call_completed` events now report `duration_ms` in milliseconds (`(2.3s)` → `2300`) instead of passing the on-screen seconds figure through unchanged (#294).
- `pluk subscribe` without `--from-beginning` no longer replays the kept tail of the log as new events when the log is rotated before the first new line arrives; the subscriber now remembers the last line already in the file at start-up and resumes after it.
- `pluk send --session=<name>` / `pluk-send --session=<name>` no longer drops a positional text word that happens to equal the session name; the leading positional is treated as the session only when `--session` is absent.
- `pluk sessions` now prints the `LAST ACTIVITY` and `EVENTS` headings with a gap between them and aligns every row with its column heading; the table matches the README example again.
- `pluk attach --rationguard` now scopes its stale-watcher reap (`pgrep -f`) to the invoking user's processes, so another user's process with a matching command line no longer makes `kill` fail and abort the attach before the rationguard watcher starts.
- `pluk attach --cli=copilot` now launches the standalone `copilot` CLI (the `gh copilot` extension was retired) and `--dangerous` maps to `--allow-all-tools` for it.
- `pluk --help`, `pluk sessions` and `pluk patterns` no longer emit ANSI colour codes when stdout is not a TTY or `NO_COLOR` is set; previously only stderr was gated.
- `pluk attach` now wires `tmux pipe-pane` before launching the CLI, so start-up output (trust dialog, login prompt, model line) is classified instead of lost (#331).
- Document the real `PLUK_RUN_DIR` default (`$XDG_RUNTIME_DIR/pluk`, else `/tmp/pluk-<uid>`) in the README and the session-monitoring runbook (#333).
- `pluk send` no longer loses a trailing `;` (tmux treats an argument ending in `;` as a command separator); the text now reaches the pane byte-for-byte (#335).
- Boolean flags such as `--enter`, `--literal`, `--verbose` and `--dangerous` now reject values other than `true`/`false` (e.g. `--enter=1`) with exit 2 instead of silently turning the flag off; `--flag=false` is the explicit off spelling.
- `pluk attach` now warns on stderr when `--command`, `--cli-args` or `--dir` are passed for a tmux session that already exists, instead of silently ignoring them (#340).
- `watch`/`subscribe --diagnostics=SECS`: a non-numeric, non-positive or `false` value (`abc`, `0`, `-5`, `5min`, `false`) used to silently run at the 60s default; it is now rejected with exit 2, as are values above 2147483 s that would overflow `setInterval` (#342).
- Cap very large finite periods passed to the `startDiagnostics` library API at Node's maximum timer delay (2147483.647 seconds) instead of overflowing into a 1 ms reporting loop; the CLI already rejects out-of-range `--diagnostics` values with exit 2 (#344).
- `pluk` now rejects unknown or misspelled `--flags` (e.g. `--captur=50`, `--entr`) with an error (exit 2) instead of silently ignoring them.
- `pluk watch --capture` now bounds each `tmux capture-pane` poll with a timeout so a hung tmux server is counted as a capture failure (visible in `--diagnostics`) instead of freezing the watcher silently (#353).
- `pluk attach --rationguard` no longer aborts a half-wired session when a stale watcher PID has already exited before `kill`; stale watchers are reaped per PID, already-gone PIDs are ignored, and other kill failures print a warning and continue.
- `pluk attach --dangerous` now passes `--yolo` to gemini and `--yes-always` to aider; a CLI with no known auto-approve flag now prints a warning even without `--verbose`.
- `pluk attach --dangerous` now launches goose with `GOOSE_MODE=auto` instead of the nonexistent `--non-interactive` flag, which made goose exit on an unknown argument.
- Subscriber tail mode preserves a partially written event at startup and delivers it once its terminating newline is appended, instead of dropping it.
- Classifier reports the tool name for Claude tool lines such as `● Bash(ls)` instead of mistaking the one-word argument for a `(kind)` suffix.
- attach: the `--dangerous` restart hint for an existing session now includes `--cli-args` (#370).
- `pluk attach` now validates the CLI command and arguments before creating the tmux session, so a bad `--cli-args` (e.g. an unterminated quote) is reported as a usage error (exit 2) instead of leaving an orphaned session with pipe-pane attached.
- `pluk sessions` now widens the SESSION and CLI columns to fit the longest value, so rows with long session or CLI names stay aligned with the header (#375).
- attach: `splitShellWords` keeps explicitly empty quoted arguments (`""` / `''`) instead of dropping them, so `--cli-args`/`--command` argv is no longer shifted (#381)
- `pluk attach --rationguard` now also kills existing watchers that were started with a custom `--rationguard-bin`, so re-attaching no longer stacks duplicate watchers.
- `pluk attach` rejects invalid `--rebuttal` values with exit code 2 before touching tmux, and warns when `--rebuttal` or `--rationguard-bin` is ignored without `--rationguard` (#280).
- Reject flags that belong to another subcommand with exit 2 and a command-specific help hint instead of silently ignoring them (including flags passed to `version`). Valid invocations are unchanged; help now lists all supported per-command flags, and a table-driven unit test checks every command against the flag union (#348).
- Mark `command_received` as reserved in the event documentation: `pluk send` / `pluk-send` does not currently emit it.
- Keep `Classifier.commandReceived()` sequence numbers in an independent, increasing command counter without changing subsequent classified or raw-output event sequence numbers.
- `pluk attach --cli=omp --dangerous` now passes `--approval-mode yolo` as two arguments; previously omp received a single `--approval-mode yolo` token and the flag had no effect.
- `pluk --help` and the README no longer point to a Go pluk binary; the `subscribe` help line now names `pluk watch` as the usual publisher.
- `--help` / `-h` after a subcommand (for example `pluk watch --help`) now prints usage and exits 0 instead of being ignored.
- `--help` anywhere is always treated as a help request (as it was before, via `parseArgs`), even inside `pluk send` text. A bare `-h` after the `send` session positional is passed through as text.
- `pluk watch --capture --include-raw` now emits `raw_output` events (once per changed frame) instead of silently ignoring the flag.
- `pluk watch` now warns on stderr when `--pane` is passed without `--capture`, and `--capture=` (empty value) is rejected with exit 2 instead of silently selecting stream mode.

### Security

- `SECURITY.md` now names `security@hivecommons.dev` (the organization's published `security.txt` contact) as the primary channel for reporting vulnerabilities, so the policy has a working private route whether or not GitHub private vulnerability reporting is enabled for the repository.

## 0.10.0 - 2026-10-10

### Added

- Added `test/cli-presentation-branches.test.js` and a `stdout-throw` fault kind in `test/fixtures/inject-fault.mjs`, pinning the `pluk watch` onEvent console.log guard, the `sessions` default run-dir and idle-row coloring, and the `patterns` default CLI and `(none)` placeholder (#195).
- `npm test` now fails on a `changelog.d/` fragment whose filename is not `<category>-<slug>.md` (category one of added/changed/deprecated/removed/fixed/security) or whose body is empty or not a markdown bullet list, so malformed fragments are caught on the PR instead of at release roll.
- Added a blameless postmortem template to the runbooks for bad releases and publish incidents.
- Added a runbook for recovering from a failed publish pipeline run, by failing job.
- Added an index for the runbooks and linked it from CONTRIBUTING.md.
- Added a runbook for diagnosing `pluk send` failures and text that does not reach the agent.
- Added a runbook for diagnosing a monitored session that stops producing events, using the `--diagnostics` counters.
- Pin the Subscriber size-shrink rotation fallback with a deterministic test: a kept tail whose leading bytes match the old head fingerprint must still be detected and resumed without replay.
- Added `test/tmux-contract.test.js`, which runs the tmux seam against a real tmux server on a private socket (skipped when tmux is not installed), so tmux-semantics regressions like #105 and #169 are caught by `npm test`.

### Changed

- CI now tests against Node 26 in addition to Node 22 and 24 (#159).
- Declared `engines.node >=22` in `package.json` and updated CONTRIBUTING.md to match: Node 20 is end-of-life and has not been in the CI matrix since the coverage gate landed. `npm install` on Node 20 now warns; a test keeps the engines floor, the Test matrix and CONTRIBUTING in sync.
- Added the dist-tag step to the release rollback runbook so the latest tag is restored to a known-good version.
- `test/tmux-contract.test.js` now fails instead of skipping when `tmux` is missing and `CI` is set, so the real-tmux lane cannot silently go dark in CI; set `PLUK_TMUX_OPTIONAL=1` to skip it deliberately.

### Fixed

- `pluk watch --capture` now rejects zero, negative and non-numeric intervals instead of busy-looping `tmux capture-pane`; `watch()` falls back to the default interval for invalid values (#147).
- Every tmux target pluk uses is now an exact session match (`-t =<session>`), so a session name can no longer resolve to a different session by prefix or be read as `window.pane`; session names may no longer contain `.`. `pluk send` and `attach` put `--` before the text, so text beginning with `-` is no longer parsed as tmux flags (#169).
- `pluk attach --rationguard-bin` / `PLUK_RATIONGUARD_BIN` is now validated before the session is created, and the rationguard watcher reports spawn errors and propagates its exit code instead of crashing with an unhandled `ENOENT` (#171).
- `pluk subscribe` no longer corrupts multi-byte UTF-8 characters (such as `✻`) that straddle a 16 KiB read boundary into U+FFFD (#170).
- Anchored the bare `429` in `RATE_LIMIT_PATTERN` for aider, codex, gemini and goose so ordinary output such as `Read 1429 lines` no longer emits false `rate_limit` events (#172).
- Fixed `pluk attach`, `pluk send` and `pluk watch --capture` failing on pane-type tmux commands: the exact session target is now `=<session>:`, which `send-keys`, `pipe-pane` and `capture-pane` accept (#188).
- Fixed `watch()` stream mode leaking the input stream 'error' listener: `stop()` now removes it and is idempotent (#193).
- Fixed `pluk sessions` showing `CLI = unknown`: `state_change` events now carry the `cli` field (#197).
- Fixed log rotation dropping lines appended while a session log was being trimmed, and tailing subscribers replaying the kept tail as duplicate events when they polled mid-rotation (#199).
- `pluk watch` and `pluk subscribe` now reject unknown or empty `--filter` event types with exit code 2 instead of silently matching nothing (#200).
- `pluk sessions` EVENTS column now counts only log lines that parse as valid events, ignoring malformed lines (#203).
- Require a nonempty CHANGELOG section before publishing a tagged version, and create its GitHub release from the curated notes after npm publication. Existing releases are left untouched.
- `stripANSI` now also removes residual control bytes (bare BEL/backspace, a dangling ESC, DEL) left by truncated or malformed sequences, so they no longer reach event payloads (#167).
- Fixed `pluk subscribe` missing an in-place log rotation when the kept tail is larger than its read offset, which produced a malformed fragment and duplicated events: rotation is now also detected when the log's leading bytes change (#208).

### Security

- `pluk attach` now pins its `npx --yes @hivecommons/pluk` pipe-pane fallback to the running package's own version instead of fetching whatever `latest` the registry serves, so an attach can no longer pull in an unreviewed release at runtime.
- `pluk attach --rationguard` no longer falls back to `npx --yes @hivecommons/rationguard` (unpinned `latest`) when `rationguard` is missing from `PATH`. It now fails before creating the tmux session with install instructions; operators who want a registry fetch choose the exact command and version themselves via the new `--rationguard-bin=<cmd>` flag or `PLUK_RATIONGUARD_BIN`.
- `pluk subscribe --verbose` now strips terminal control characters from event fields before echoing them, and `stripANSI` recognises the full ECMA-48 set (OSC terminated by ST, RIS, DCS/APC/PM/SOS strings, CSI with intermediate bytes, 8-bit C1 controls). Previously a monitored agent could print a `model` line carrying such sequences and have them replayed raw into the operator's terminal and persisted into every event payload.

## 0.9.0 - 2026-10-02

### Added

- `pluk watch` and `pluk subscribe` accept `--diagnostics[=secs]`, an opt-in, local-only health summary (bounded counters for capture failures, swallowed input errors, malformed/filtered lines and emitted events) written as JSON lines to stderr; the same counters are exposed via `watch(...).stats()` and `Subscriber#stats()` (#102).
- Add `runbooks/release-rollback.md` documenting how to contain and fix
  forward a bad `@hivecommons/pluk` npm release (deprecate/pin/fix-forward),
  since `publish.yml` auto-publishes on tag push with no rollback procedure
  documented for downstream consumers (rationguard, hive agents).

### Fixed

- Bound local session event-log growth for long-running sessions: `pluk watch` now periodically rotates its JSONL log once it exceeds a size threshold (default 10MiB via `PLUK_LOG_MAX_BYTES`), trimming it down to the last N lines (default 5000 via `PLUK_LOG_KEEP_LINES`).
- Fixed `publish.yml` so the test suite runs on the tagged ref before `npm publish`, closing the gap where a tag push could publish an untested package.
- `pluk attach` on a session that already has pluk attached no longer turns event logging off: `tmux pipe-pane` is now invoked without `-o` (a toggle that closes an existing pipe without opening a new one), so a repeat attach replaces the watcher instead of silently stopping it.
- `pluk subscribe` (and every `Subscriber` consumer, including the rationguard watcher) no longer stalls permanently after `pluk watch` rotates the session log: a tail whose byte offset is past the shrunken file now re-reads the kept tail and resumes exactly after the last line it already delivered, instead of reading zero bytes forever.
