# Contributing to pluk

Thanks for helping improve pluk. This project follows the same lightweight contribution expectations as other hivecommons tools.

## Local development

Requirements:

- Node.js 22 or newer (the floor declared in `package.json` `engines.node` and the oldest major in the CI matrix)
- npm
- tmux, if you are manually exercising `pluk attach`, `pluk watch --capture`, or `pluk send`

Set up and validate the project:

```sh
npm ci
npm run build
npm test
```

`npm test` runs the TypeScript build first and then the Node test suite (via `scripts/run-tests.mjs`). Run it before opening a pull request.

On Node 22 or newer, `npm test` also enforces the project coverage thresholds (lines 99, branches 96, functions 98) over `dist/` and `scripts/`, exactly as CI does; `npm run test:coverage` is an explicit alias for the same check.

## Making changes

- Keep changes focused and add tests for behavior changes.
- Prefer small helpers that can be unit-tested without requiring a live tmux session.
- Do not commit generated `dist/` output unless a maintainer explicitly asks for it.
- Update README examples when CLI behavior or flags change.
- For user-visible changes, add a fragment to `changelog.d/` named `<category>-<slug>.md`, where `<category>` is one of `added`, `changed`, `deprecated`, `removed`, `fixed` or `security` and `<slug>` is lowercase `[a-z0-9-]` (for example `fixed-<slug>.md`). The body is a markdown bullet list (`- ...`) — `test/changelog-fragments.test.js` fails `npm test` on a misnamed, empty or non-bullet fragment.

## Adding or fixing a pattern set

Pattern sets are the easiest way to start contributing to pluk. To report a misclassification or ask for a new CLI without writing the patterns yourself, use the [pattern request form](https://github.com/hivecommons/pluk/issues/new?template=pattern_request.yml).

### Fixing an existing pattern set

1. Copy `patterns/<cli>.patterns` into a scratch directory and change it there. Pipe real terminal output through `pluk watch <session> --cli=<cli> --patterns-dir=<dir>` until it produces the events you expect. See [Pattern File Format](README.md#pattern-file-format) for the keys.
2. Copy the change into `patterns/<cli>.patterns` **and** into that CLI's inline constant in `src/patterns.ts`. Both must stay identical. The test "inline builtin patterns match the bundled pattern files field-for-field" in `test/patterns.test.js` fails if they differ.
3. Add a test in `test/patterns-semantics.test.js` that feeds the real terminal lines to the classifier and asserts which event comes out.

### Adding a new CLI

Several files must agree on which CLIs pluk supports, and `test/cli-support-matrix.test.js` checks that they do. A new CLI touches all of them:

| File | Change |
|------|--------|
| `patterns/<cli>.patterns` | The bundled pattern set. It needs at least `IDLE_PATTERN` and `ERROR_PATTERN`. |
| `src/patterns.ts` | Add a `<CLI>_PATTERNS` constant with the same content as the bundled file and register it in `BUILTIN_PATTERNS`. |
| `src/attach.ts` | Add the launch command to `CLI_COMMANDS`. If the CLI has a permission-skip flag, add it to `DANGEROUS_FLAGS` too. |
| `README.md` | Add the name to the `--cli=` row of the Attach Flags table and the **Supported CLIs** list. Add any permission-skip flag to the `--dangerous` row. |
| `test/patterns-semantics.test.js` | Add tests showing that real output from the CLI produces the right events. |
| `changelog.d/added-<cli>-patterns.md` | Add a changelog fragment. |

PR #225, which added `omp`, is a complete worked example.

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
