# Runbook: `pluk send` fails or text does not reach the agent

Use this when `pluk send` exits non-zero, or exits 0 but the agent never
reacts, for example a rationguard rebuttal (`--rebuttal=send`) that is logged
but never lands in the session.

## Who is affected

Anything injecting input into a monitored tmux session: rationguard rebuttal
delivery and hive agents that nudge a session. When delivery fails, the agent
keeps acting on the rationalization the rebuttal was meant to stop.

## Triage

1. Read the exit status and message. A failure prints
   `failed to send to session "<name>": ...` and exits 1.
2. Does the session exist? `send` targets the exact name (`=<name>:`), so a
   prefix or a stale name does not match.
   ```sh
   pluk sessions
   tmux has-session -t "=<session>:"
   ```
3. Is the tmux server reachable from the sending process? It must see the same
   socket (`TMUX`, `TMUX_TMPDIR`, same user) as the session's owner.
   ```sh
   tmux list-sessions
   ```
4. Exit 0 but nothing happened: confirm the text arrived in the pane.
   ```sh
   tmux capture-pane -p -t "=<session>:" | tail -20
   ```

## Common causes

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `can't find session` | Session ended or name mismatch | Use the name from `pluk sessions`; re-run `pluk attach` if the session died |
| `no server running` / `error connecting` | Different user or socket | Run as the session's owner or export the matching `TMUX_TMPDIR` |
| `spawn tmux ENOENT` | tmux not on `PATH` | Install tmux or fix `PATH` for the sender |
| Text appears but is not submitted | `--enter` omitted | Re-send with `--enter` |
| Text appears as a key name or is mangled | Bare form interprets tmux key names | Use `--literal` for verbatim text |
| Text lands but the agent ignores it | Agent is mid-output or showing a prompt | Wait for the idle state, then re-send; do not loop-resend |

## Recovery

1. Fix the cause above and re-send once with `--enter`.
2. If rebuttals are delivered by rationguard, confirm it uses the same
   environment as the failing manual send.
3. If manual sends work but the automatic path does not, treat it as a
   regression: see [release-rollback.md](release-rollback.md) and file a
   postmortem using [postmortem-template.md](postmortem-template.md).
