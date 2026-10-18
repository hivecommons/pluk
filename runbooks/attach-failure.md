# Runbook: `pluk attach` fails or leaves a session unmonitored

Use this when `pluk attach` exits non-zero, or exits cleanly but the session is
not being captured, for example no events appear in the log, or the rationguard
watcher is missing or has exited.

## Who is affected

Anyone who starts a monitored agent with `pluk attach`. A session that is
attached without capture, or whose rationguard watcher has died, keeps running
with no excuse detection and no rebuttals.

## Triage

1. Re-run with `--verbose` and read the stderr trace. It prints the run
   directory, log file, `pipe-pane` command and rationguard command used.
2. Did it stop on a validation error?
   - `Unsafe session name "<name>"`: use only letters, numbers, `_` and `-`.
   - `CLI command cannot be empty` / `Unterminated quote in command arguments`:
     fix the `--command` / `--cli-args` value.
3. Is the session being captured? A `Warning: pluk binary not found, skipping
   pipe-pane attachment` line means the session runs but nothing is logged.
   ```sh
   command -v pluk
   tmux show-options -t "=<session>:" ; tmux list-panes -t "=<session>:" -F '#{pane_pipe}'
   ls -l "<run-dir>/logs/<session>.jsonl"
   ```
   `pane_pipe` is `1` when the pipe-pane is active.
4. With `--rationguard`, is exactly one watcher running for this session?
   ```sh
   pgrep -fa "rationguard.* watch <session>( |$)"
   ```
5. Does the tmux server answer for the session's owner?
   ```sh
   tmux has-session -t "=<session>:"
   ```

## Common causes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `rationguard not found on PATH` | rationguard is not installed | `npm install -g @hivecommons/rationguard`, or pass `--rationguard-bin=COMMAND` / set `PLUK_RATIONGUARD_BIN` |
| `--rationguard-bin / PLUK_RATIONGUARD_BIN command not found or not executable` | Override points at a missing command | Fix the path; the first word of the override must resolve |
| `Failed to start rationguard (<cmd>)` | Binary exists but cannot be spawned | Run `<cmd> --version` directly; fix permissions or `PATH` |
| `pluk binary not found, skipping pipe-pane attachment` | `pluk` is not on `PATH` for the attaching process | `npm install -g @hivecommons/pluk`, then re-run `pluk attach <session>` |
| Session exists but the CLI was not started with the expected flags | Attached to an existing session; `--dangerous` only applies to new sessions | Restart the CLI using the command in the printed warning |
| No events although the pipe-pane is active | Wrong `--cli` classifier for the agent | Re-attach with the right `--cli`; see [session-monitoring-failure.md](session-monitoring-failure.md) |
| Rationguard watcher stops when the terminal closes | The watcher runs in the attaching terminal, not in the background | Re-run `pluk attach <session> --rationguard`; keep that terminal open (or run it in its own tmux window) |
| Two watchers answer one session | Watcher started by hand alongside `attach` | Re-run `pluk attach`; it stops existing watchers for the exact session name before starting a new one |

## Recovery

1. Fix the cause above and re-run `pluk attach <session>` with the same
   options. Re-attaching to an existing session is safe: it re-installs the
   pipe-pane and replaces the session's rationguard watcher.
2. Confirm capture: send the agent a trivial prompt and check that new lines
   reach `<run-dir>/logs/<session>.jsonl`.
3. Confirm detection: the rationguard terminal should print detections, and
   `--rebuttal=send` rebuttals should land (see [send-failure.md](send-failure.md)).
4. If attach worked on the previous release and fails on the current one,
   treat it as a regression: see [release-rollback.md](release-rollback.md) and
   file a postmortem using [postmortem-template.md](postmortem-template.md).
