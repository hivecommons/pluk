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

`npm test` runs the TypeScript build first and then the Node test suite (`node --test "test/**/*.test.js"`). Run it before opening a pull request.

## Making changes

- Keep changes focused and add tests for behavior changes.
- Prefer small helpers that can be unit-tested without requiring a live tmux session.
- Do not commit generated `dist/` output unless a maintainer explicitly asks for it.
- Update README examples when CLI behavior or flags change.

## Pull requests

1. Branch from `main`.
2. Make the change with tests or documentation updates as appropriate.
3. Run `npm test` locally.
4. Open a PR that explains the user-visible change and links any issue it fixes.

## Developer Certificate of Origin

All commits must be signed off to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "your message"
```

This adds a `Signed-off-by:` trailer. PRs with unsigned commits will fail DCO checks.
