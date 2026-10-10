# Changelog

All notable changes to this project are documented in this file.

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
