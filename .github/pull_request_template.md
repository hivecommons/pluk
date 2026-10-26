## Summary

<!-- What does this PR change, and why? Describe any user-visible changes and link any issue it fixes. -->

## Validation

<!-- How did you check the change? Include commands run or manual steps. -->

## Checklist

See [CONTRIBUTING.md](https://github.com/hivecommons/pluk/blob/main/CONTRIBUTING.md) for details.

- [ ] This PR branches from `main` and keeps changes focused.
- [ ] `npm test` passes locally (it runs the build and, on Node.js 22+, enforces coverage: 99% lines, 96% branches, 98% functions).
- [ ] Behavior changes include tests; CLI behavior or flag changes include updated README examples, if applicable.
- [ ] User-visible changes include a `changelog.d/<category>-<slug>.md` fragment: category is `added`, `changed`, `deprecated`, `removed`, `fixed` or `security`, slug uses lowercase `[a-z0-9-]`, and the body is a non-empty Markdown bullet list.
- [ ] Generated `dist/` output is excluded unless a maintainer explicitly requested it.
- [ ] If patterns changed: `patterns/<cli>.patterns` and the matching inline constant in `src/patterns.ts` are identical, and `test/patterns-semantics.test.js` covers real terminal output.
- [ ] If adding a CLI: updated `patterns/<cli>.patterns`, `src/patterns.ts`, `src/attach.ts`, `README.md`, `test/patterns-semantics.test.js` and `changelog.d/added-<cli>-patterns.md` as described in CONTRIBUTING.
- [ ] All commits are signed off (`git commit -s`) for the Developer Certificate of Origin.
