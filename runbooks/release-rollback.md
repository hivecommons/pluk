# Runbook: rolling back a bad pluk release

`publish.yml` runs `npm test` against the tagged ref and then publishes to npm
on every `v*` tag push. Tests reduce risk but cannot catch every regression
(for example, behavior that only breaks under a real tmux session, a
downstream consumer's assumptions, or an environment-specific failure). This
runbook covers what to do once a bad version has already reached the npm
registry.

## Who is affected

`pluk` is consumed by:

- Anyone running `npm install -g @hivecommons/pluk` directly.
- `@hivecommons/rationguard`, which shells out to pluk's classify/watch output.
- hive hub/spoke agents that call `pluk attach` to wire up monitored sessions.

A broken publish can silently break session monitoring or rebuttal delivery
for all of the above, so treat a bad release as user-impacting, not just a
packaging nit.

## Detect

- `npm view @hivecommons/pluk versions --json` to confirm what shipped.
- Compare the published `dist/` behavior against the tagged source if the
  regression is not obvious from the changelog/diff.
- Check open issues/PRs for reports referencing the new version number.

## Contain

1. **Deprecate the bad version** so new installs warn instead of silently
   picking it up:
   ```sh
   npm deprecate @hivecommons/pluk@<bad-version> "Known issue: <short description>, use <good-version> instead"
   ```
2. **Repoint `latest` at the last good version.** Deprecating does not move
   the `latest` dist-tag, so a plain `npm install -g @hivecommons/pluk` still
   resolves to the bad version until a fix ships:
   ```sh
   npm view @hivecommons/pluk dist-tags --json
   npm dist-tag add @hivecommons/pluk@<last-good-version> latest
   ```
   After the fix-forward release publishes, `latest` moves to it automatically.
3. **Do not `npm unpublish`** unless the version is less than 72 hours old and
   npm's unpublish policy allows it — unpublishing an older version can break
   other projects that already resolved to it. Prefer deprecate + forward fix.
4. If the bad version broke `pluk attach`/`watch` for active hive sessions,
   tell operators to pin the last known-good version until a fix ships:
   ```sh
   npm install -g @hivecommons/pluk@<last-good-version>
   ```

## Fix forward

1. Branch from `main`, fix the regression, and add a regression test per
   `CONTRIBUTING.md`.
2. Bump the version in `package.json` and land the fix through the normal PR
   process.
3. Tag `vX.Y.Z` on `main` once merged; `publish.yml` runs the test suite
   against that tag and publishes automatically.
4. Add a `changelog.d/fixed-<slug>.md` fragment describing the regression and
   the fix, following the existing entries in `changelog.d/`.

## After

- Confirm `npm view @hivecommons/pluk@latest version` matches the new patched
  release (or the pinned good version while the fix is pending).
- Confirm the deprecation notice on the bad version is still visible
  (`npm view @hivecommons/pluk@<bad-version>` shows the `deprecated` field).
- Note the incident in the PR/issue that tracked the fix so future readers can
  find the rollback steps that were actually used.
