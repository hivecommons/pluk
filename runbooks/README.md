# Runbooks

Start here when something is wrong with a pluk release or a monitored session.

| Symptom | Runbook |
| --- | --- |
| A `v*` tag push failed in `verify-tag`, `publish`, or `release` | [publish-failure.md](publish-failure.md) |
| A published version is broken and must be withdrawn or superseded | [release-rollback.md](release-rollback.md) |
| `pluk subscribe` / `pluk watch` goes quiet for a session that should be active | [session-monitoring-failure.md](session-monitoring-failure.md) |
| After any incident that reached users | [postmortem-template.md](postmortem-template.md) |
