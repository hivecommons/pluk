# Runbook: a monitored session stops producing events

Use this when `pluk subscribe` shows nothing for a session that should be
active, or rationguard/hive stop receiving state changes, rate-limit or error
events. pluk swallows capture and parse failures on purpose so the pipe-pane
process never dies, so silence alone cannot distinguish "quiet session" from
"broken monitoring". The `--diagnostics` counters can.

## Who is affected

Anything consuming the session's JSONL log: `@hivecommons/rationguard`
(rebuttal delivery) and hive agents that watch for rate limits and errors.
A silent watcher means those consumers act on stale state.

## Triage

1. Is the session known and is the tmux session alive?
   ```sh
   pluk sessions
   tmux has-session -t <session>
   ```
2. Is the log file growing? The run dir is `$PLUK_RUN_DIR` (default
   `/tmp/pluk-run`).
   ```sh
   ls -l "${PLUK_RUN_DIR:-/tmp/pluk-run}"/logs/
   ```
3. Is a watcher still attached to the pane?
   ```sh
   tmux display-message -p -t <session> '#{pane_pipe}'   # 1 = piped
   ```
4. Restart the watcher with diagnostics and read the counters on stderr:
   ```sh
   pluk watch <session> --cli=<cli> --capture --diagnostics=10 >/dev/null
   ```

## Reading the counters

| Counter | Meaning when it is wrong | Action |
|---------|--------------------------|--------|
| `captureFailures` rising with `framesPolled` | Pane gone or tmux unreachable | Confirm the session exists and `TMUX`/socket is visible to the watcher; re-run `pluk attach` |
| `framesPolled` = 0 in `--capture` mode | Watcher not polling | Check the `--capture` interval is valid and restart |
| `linesSeen` = 0 in stream mode | Nothing reaches stdin | `pane_pipe` is 0: re-attach so `tmux pipe-pane` is re-established |
| `classifyErrors` > 0 | Lines dropped by the classifier | Capture a sample, add a regression test, fix forward |
| `inputErrors` > 0 | Input stream errored | Re-attach; check for tmux server restarts |
| `eventsFiltered` ≈ `linesSeen` | `--filter` excludes everything | Review the filter set |
| `malformedLines` rising (subscriber) | Log has non-pluk lines | Check for another writer on the log file or truncated rotation |

If counters are healthy and events still do not arrive, the CLI may have no
bundled patterns (`codex`, `aider`): pass `--patterns-dir`.

## Recover

1. Re-run `pluk attach <session> --cli=<cli>` to re-establish `pipe-pane`.
2. If the log is oversized or corrupt, rotation keeps the trailing
   `PLUK_LOG_KEEP_LINES` lines; move the file aside and let the watcher
   recreate it.
3. If a recent pluk release is the cause, follow `release-rollback.md`.

## After

Record the cause and detection gap with `postmortem-template.md` if
rationguard or hive acted on stale state.
