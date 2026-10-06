# Runbook: a tag push whose publish pipeline failed

`publish.yml` runs three jobs on every `v*` tag push: `verify-tag`, then
`publish` (npm), then `release` (GitHub release). Which job failed decides the
recovery. For a version that already reached npm and is bad, use
`release-rollback.md` instead.

## Triage

```sh
gh run list --workflow publish.yml --limit 5
gh run view <run-id> --log-failed
npm view @hivecommons/pluk versions --json
```

Confirm whether the version is on npm before choosing a path below.

## `verify-tag` failed (nothing published)

The tag does not match `package.json`, is not reachable from `main`, or
`CHANGELOG.md` has no non-empty `## <version>` section. Nothing reached npm.

1. Land the missing fix (version bump, changelog roll) on `main`.
2. Move the tag to the corrected commit:
   ```sh
   git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
   git tag vX.Y.Z <main-commit> && git push origin vX.Y.Z
   ```

## `publish` failed (version not on npm)

If `npm view @hivecommons/pluk@X.Y.Z version` returns nothing, the failure was
tests, build, smoke-test, or registry/auth (`NPM_TOKEN`). Fix the cause, then use
**Re-run failed jobs** on the run. If the fix needs a code change, follow the
`verify-tag` path above to retag.

## `publish` succeeded but `release` failed (version on npm)

Do not retag and do not republish; npm versions are immutable. Use
**Re-run failed jobs** on the run: the release step skips creation if the
GitHub release already exists, so re-running is safe. If notes extraction
failed, fix `CHANGELOG.md` on `main` first, then create the release by hand:

```sh
gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <notes.md>
```

## After

- `npm view @hivecommons/pluk@latest version` matches the intended version.
- `gh release view vX.Y.Z` exists.
- Note the failure and recovery path in the tracking issue or PR.
