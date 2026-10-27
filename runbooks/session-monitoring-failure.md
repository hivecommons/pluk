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
2. Is the log file growing? The run dir is `$PLUK_RUN_DIR` (defaults to
   `$XDG_RUNTIME_DIR/pluk` when set, else `/tmp/pluk-<uid>` where uid is the current user).
   ```sh
   ls -l "${PLUK_RUN_DIR:-${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/pluk}}"/logs/   # with XDG_RUNTIME_DIR set
   ls -l "${PLUK_RUN_DIR:-/tmp/pluk-$(id -u)}"/logs/                        # without it
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

Each stderr line is one JSON object: `pluk_diagnostics` (schema version), `command`
(`watch` or `subscribe`), `uptime_s`, and `final` (`true` only on the closing summary
written at shutdown), followed by the counters below. Counters are cumulative since
start, so judge a rate by comparing two consecutive lines.

| Counter | Meaning when it is wrong | Action |
|---------|--------------------------|--------|
| `captureFailures` rising with `framesPolled` | Pane gone, tmux unreachable, or the tmux server is wedged (accepts the socket but `capture-pane` exceeds the 5 s query timeout, surfacing as `ETIMEDOUT`) | Confirm the session exists and `TMUX`/socket is visible to the watcher; time `tmux list-sessions` and restart the tmux server if it takes more than a few seconds; re-run `pluk attach` |
| `framesPolled` = 0 in `--capture` mode | Watcher not polling | Check the `--capture` interval is valid and restart |
| `linesSeen` = 0 in stream mode | Nothing reaches stdin | `pane_pipe` is 0: re-attach so `tmux pipe-pane` is re-established |
| `classifyErrors` > 0 | Lines dropped by the classifier | Capture a sample, add a regression test, fix forward |
| `inputErrors` > 0 | Input stream errored | Re-attach; check for tmux server restarts |
| `eventsEmitted` = 0 while `linesSeen` (stream) or `framesPolled` (capture) keeps rising | Input arrives but nothing classifies into an event, or every event is filtered | Compare with `eventsFiltered`: if that is also rising, review `--filter`; otherwise no pattern in the set matches this CLI's output (`pluk patterns --cli=<cli>`) |
| `linesRead` = 0 (subscriber) | The log file is empty or the subscriber is reading the wrong run dir | Check the log path and `PLUK_RUN_DIR` above; confirm the watcher is writing |
| `eventsFiltered` ≈ `linesSeen` | `--filter` excludes everything | Review the filter set |
| `malformedLines` rising (subscriber) | Log has non-pluk lines | Check for another writer on the log file or truncated rotation |

If counters are healthy and events still do not arrive, check that a pattern
set exists for the CLI name you passed (`pluk patterns --cli=<cli>` lists the
bundled sets); for an unsupported CLI, pass `--patterns-dir`.

## Recover

1. Re-run `pluk attach <session> --cli=<cli>` to re-establish `pipe-pane`.
2. If the log is oversized or corrupt, rotation keeps the newest
   lines, up to `PLUK_LOG_KEEP_LINES` lines and within the
   `PLUK_LOG_MAX_BYTES` byte cap (default 10 MiB); move the file aside and let the watcher
   recreate it.
3. If a recent pluk release is the cause, follow `release-rollback.md`.

## After

Record the cause and detection gap with `postmortem-template.md` if
rationguard or hive acted on stale state.
