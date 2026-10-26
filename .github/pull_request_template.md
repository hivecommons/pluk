## Summary

<!-- What does this PR change, and why? Describe any user-visible changes. -->

Fixes #<!-- issue number, if this PR resolves one -->

## Validation

<!-- How did you check the change? Include commands run, and the tmux session/CLI you exercised for attach, watch --capture or send. -->

## Checklist

See [CONTRIBUTING.md](https://github.com/hivecommons/pluk/blob/main/CONTRIBUTING.md) for details.
Do not report security vulnerabilities in a public PR. Follow [SECURITY.md](https://github.com/hivecommons/pluk/blob/main/SECURITY.md) instead.

- [ ] `npm test` passes locally (it builds first and, on Node 22+, enforces the coverage thresholds: lines 99, branches 96, functions 98)
- [ ] If the change is user-visible: a `changelog.d/<category>-<slug>.md` fragment is included (category one of `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`; body is a `- ` bullet list)
- [ ] If CLI behavior or flags changed: README examples are updated
- [ ] If a pattern set changed: `patterns/<cli>.patterns` and its inline constant in `src/patterns.ts` are identical
- [ ] If a CLI was added: every file in CONTRIBUTING's "Adding a new CLI" table is updated
- [ ] Generated `dist/` output is not committed
- [ ] Behavior changes include tests
- [ ] Commits are signed off (`git commit -s`)
