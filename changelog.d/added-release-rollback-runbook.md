- Add `runbooks/release-rollback.md` documenting how to contain and fix
  forward a bad `@hivecommons/pluk` npm release (deprecate/pin/fix-forward),
  since `publish.yml` auto-publishes on tag push with no rollback procedure
  documented for downstream consumers (rationguard, hive agents).
