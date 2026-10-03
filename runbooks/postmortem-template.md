# Postmortem: <short title>

Use this after a bad release, a failed publish, or any incident that reached
users of `@hivecommons/pluk`. Keep it blameless and fact-based. Related
runbooks: `release-rollback.md`, `publish-failure.md`.

## Summary

One or two sentences: what broke, who was affected, how long.

## Impact

- Affected versions:
- Affected users or workflows (for example `pluk attach`, `pluk watch`, `pluk send`):
- Detection time and who or what detected it:
- Time to mitigation and time to full resolution:

## Timeline (UTC)

| Time | Event |
|------|-------|
|      |       |

## Root cause

What condition made the failure possible, and why existing checks (tests,
`verify-tag`, changelog guard) did not stop it.

## Mitigation and recovery

What was done (deprecate, dist-tag repoint, fix-forward) and which runbook step
was used. Note any step that was missing or wrong.

## What went well / what went poorly

-

## Action items

| Action | Owner | Tracking issue | Due |
|--------|-------|----------------|-----|
|        |       |                |     |
