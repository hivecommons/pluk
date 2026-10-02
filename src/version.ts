import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Version from the package's own package.json (adjacent to dist/), so it never drifts. */
export function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * npm package spec for the npx fallback in `pluk attach`. Pinned to the
 * running release so the pipe-pane never pulls whatever `latest` is on the
 * registry at attach time; falls back to the unversioned name only when the
 * version is unreadable.
 */
export function plukPackageSpec(version: string = packageVersion()): string {
  return version === 'unknown' ? '@hivecommons/pluk' : `@hivecommons/pluk@${version}`;
}
