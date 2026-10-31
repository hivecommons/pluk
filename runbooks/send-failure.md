# Runbook: `pluk send` fails or text never reaches the agent

Use this when `pluk send` exits non-zero, or exits cleanly but the text does
not appear in the agent's pane, including rebuttals from
`pluk attach --rationguard --rebuttal=send`.

## Who is affected

Anyone injecting text into a monitored session. A failed send leaves the agent
without the rebuttal or command it was meant to receive; pluk does not retry.

## Triage

1. Read the exit code and stderr.
   - Exit 1 with `session name is required` or `text is required`: fix the
     arguments (`pluk send <session> --text="..."`).
   - Exit 1 with `failed to send to session "<name>": ...`: tmux rejected the
     send; the message carries tmux's own error.
2. Does the session exist under that exact name? pluk matches names exactly
   (`=<name>:`), so a prefix or a different case does not match.
   ```sh
   tmux has-session -t "=<session>:" && echo ok
   pluk sessions
   ```
3. Does the tmux server answer for the user running `pluk send`? A different
   user, or a different `TMUX_TMPDIR`, talks to a different server.
4. Text arrived but did not run: `pluk send` types the text only. Add
   `--enter` to press Enter afterwards.
5. Text arrived mangled: use `--literal` so tmux types it verbatim instead of
   looking up key names.

## Common causes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `can't find session` / `no server running` | Session ended, wrong name, or wrong tmux server | Check step 2 and 3; re-run `pluk attach` if the session was recreated |
| `tmux: command not found` | tmux is not on `PATH` for the caller | Install tmux or fix `PATH` for the calling process |
| Text typed but not submitted | `--enter` was not passed | Re-send with `--enter` |
| Key name typed as a key (for example `C-c`) | Bare form sends via tmux key lookup | Pass `--literal` to type the characters |
| Rebuttals never arrive | Attach was started without `--rebuttal=send`, or the rationguard watcher died | See [attach-failure.md](attach-failure.md) |

## Recovery

1. Fix the cause and re-run the same `pluk send` command.
2. Confirm: `tmux capture-pane -p -t "=<session>:"` shows the text in the pane.
3. If rebuttals are still not delivered, re-run `pluk attach <session>
   --rationguard --rebuttal=send`; re-attaching is safe.
4. If send worked on the previous release and fails on the current one, treat
   it as a regression: see [release-rollback.md](release-rollback.md) and
   file a postmortem using [postmortem-template.md](postmortem-template.md).
