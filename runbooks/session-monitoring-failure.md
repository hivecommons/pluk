# Runbook: `pluk subscribe` / `pluk watch` goes quiet

Use this when `pluk subscribe` or `pluk watch` prints nothing for a session
that should be active, exits with an error, or reports the wrong state.

## Who is affected

Anyone consuming the JSONL event stream. A silent subscriber looks identical
to an idle agent, so rate limits, errors and stalls go unnoticed.

## Triage

1. Is the log file being written?
   ```sh
   ls -l "<run-dir>/logs/<session>.jsonl"; tail -n 3 "<run-dir>/logs/<session>.jsonl"
   ```
   The run directory is `--run-dir`, else `PLUK_RUN_DIR`, else pluk's default.
   Subscribers must use the same run directory as the publisher.
2. Did `pluk subscribe` exit with `Timeout waiting for <path>`? The log did not
   appear within 60 s: the session was never attached, the name differs, or the
   run directory differs. See [attach-failure.md](attach-failure.md).
3. Re-run with `--verbose` to see rotation and resume messages on stderr.
4. Turn on local health counters (stderr, one JSON line per period, no session
   names or output): `--diagnostics` or `--diagnostics=<secs>`.
   | Counter | Meaning if high |
   | --- | --- |
   | `captureFailures` (watch `--capture`) | tmux pane gone, wrong `--pane`, or tmux unreachable |
   | `classifyErrors`, `inputErrors` (watch) | Malformed input or a broken input stream |
   | `emitErrors` (watch) | The event sink threw; events were classified but not delivered |
   | `eventsFiltered` | `--filter` is dropping the types you expect |
   | `malformedLines` (subscribe) | The log contains lines that are not pluk events |
   | `linesSeen` / `linesRead` stuck at 0 | Nothing is reaching the watcher or log |
5. Does `pluk sessions` show the session with the expected CLI and state?

## Common causes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| No events, log not growing | Pipe-pane not active | `tmux list-panes -t "=<session>:" -F '#{pane_pipe}'` should print `1`; re-run `pluk attach <session>` |
| Events never match | Wrong `--cli` classifier | Re-attach or re-run `pluk watch` with the right `--cli` (or `--patterns-dir`) |
| TUI agent shows no state changes | Pipe-pane stream has no line feeds | Use `pluk watch --capture` to classify whole frames |
| Subscriber sees nothing, log grows | Different `--run-dir` / `PLUK_RUN_DIR` | Align the run directory on both sides |
| Only old events replay, or none | Subscribing from the end of the log | Add `--from-beginning` |
| Filtered out | `--filter` lists the wrong event types | Fix the list or drop the flag |
| Subscriber resumes after a gap | Log rotated at `PLUK_LOG_MAX_BYTES`, keeping `PLUK_LOG_KEEP_LINES` lines | Expected; raise the limits if history is needed |
| `Refusing to use ...` | Run-dir ownership or symlink check | See [run-dir-refused.md](run-dir-refused.md) |

## Recovery

1. Fix the cause and restart the subscriber; it does not need the publisher
   restarted unless the pipe-pane or watcher itself is the problem.
2. Confirm: send the agent a trivial prompt and watch a new event arrive.
3. If detection regressed on the current release, see
   [release-rollback.md](release-rollback.md) and file a postmortem using
   [postmortem-template.md](postmortem-template.md).
