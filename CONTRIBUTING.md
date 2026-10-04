# Contributing to pluk

Thanks for helping improve pluk. This project follows the same lightweight contribution expectations as other hivecommons tools.

## Local development

Requirements:

- Node.js 20 or newer
- npm
- tmux, if you are manually exercising `pluk attach`, `pluk watch --capture`, or `pluk send`

Set up and validate the project:

```sh
npm ci
npm run build
npm test
```

`npm test` runs the TypeScript build first and then the Node test suite (via `scripts/run-tests.mjs`). Run it before opening a pull request.

To check coverage against the project thresholds (lines 95, branches 85, functions 90), run:

```sh
npm run test:coverage
```

## Making changes

- Keep changes focused and add tests for behavior changes.
- Prefer small helpers that can be unit-tested without requiring a live tmux session.
- Do not commit generated `dist/` output unless a maintainer explicitly asks for it.
- Update README examples when CLI behavior or flags change.
- For user-visible changes, add a fragment to `changelog.d/` named `<category>-<slug>.md`, where `<category>` is one of `added`, `changed`, `deprecated`, `removed`, `fixed` or `security` and `<slug>` is lowercase `[a-z0-9-]` (for example `fixed-<slug>.md`). The body is a markdown bullet list (`- ...`) — `test/changelog-fragments.test.js` fails `npm test` on a misnamed, empty or non-bullet fragment.

## Pull requests

1. Branch from `main`.
2. Make the change with tests or documentation updates as appropriate.
3. Run `npm test` locally.
4. Open a PR that explains the user-visible change and links any issue it fixes.

## Operations

For failed publishes, bad releases, or silent monitored sessions, see the [runbooks](runbooks/README.md).

## Developer Certificate of Origin

All commits must be signed off to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "your message"
```

This adds a `Signed-off-by:` trailer. PRs with unsigned commits will fail DCO checks.
