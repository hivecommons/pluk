# Changelog

All notable changes to this project are documented in this file.

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
