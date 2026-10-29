# Runbook: pluk refuses to use its run directory or a session log

Use this when `pluk attach`, `subscribe`, `watch` or `sessions` fails with a
message starting `Refusing to use ...` or `Unsafe session name ...`. These are
deliberate guards: the run directory holds session logs, which can contain
agent output, so pluk will not write into a path another user could control.

## Who is affected

Anything that attaches to or reads a session: rationguard watchers and hive
agents. While the guard trips, the session is not captured and no events are
emitted, so a drifting agent goes unnoticed.

## Triage

1. Find the directory pluk resolved. Order is `--run-dir`, then
   `PLUK_RUN_DIR`, then `$XDG_RUNTIME_DIR/pluk`, then `<tmpdir>/pluk-<uid>`.
   ```sh
   echo "${PLUK_RUN_DIR:-${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/pluk}}"
   ls -ldn "${TMPDIR:-/tmp}/pluk-$(id -u)"
   ```
2. Compare the owner and type of the path in the error with `id -u`.
   ```sh
   ls -ldn <path-from-error>
   ```

## Common causes

| Message | Likely cause | Action |
| --- | --- | --- |
| `Refusing to use directory not owned by current user` | Dir created by another user, or by root via `sudo` | Point at a private dir you own with `--run-dir` or `PLUK_RUN_DIR`; do not `chown` a dir you did not create without checking its contents |
| `Refusing to use log file not owned by current user` | A log inside the run dir was written by another user | Same as above; move the stale log aside after reading it |
| `Refusing to use symlinked directory` / `symlinked log file` | Path was replaced by a symlink, possibly hostile | Inspect the link target, remove the link, and re-attach with a fresh `--run-dir` |
| `Refusing to use non-directory path` / `non-file log path` | A regular file or device sits where pluk expects a dir or log | Remove or rename it |
| `Unsafe session name` | Session name has characters other than letters, digits, `_` and `-` | Use a conforming name; the tmux session may need renaming |

## Recovery

1. Pick an owned directory and re-attach once:
   ```sh
   export PLUK_RUN_DIR="$(mktemp -d)"
   pluk attach <session>
   ```
   Use the same value for `subscribe`, `watch` and `sessions`, or they will
   not see the new logs.
2. Confirm events flow: `pluk sessions` lists the session with a recent
   timestamp.
3. Do not loosen the guards or run pluk as root to get past the error. If the
   foreign-owned path appeared without explanation, treat it as a possible
   security incident and report it per [SECURITY.md](../SECURITY.md).
4. If the guard trips on a path you own, treat it as a regression: see
   [release-rollback.md](release-rollback.md) and file a postmortem using
   [postmortem-template.md](postmortem-template.md).
