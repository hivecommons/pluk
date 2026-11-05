import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateLogFile, resolveRunDir } from './run-dir.js';

/**
 * Publish the latest process snapshot, never a cross-process aggregate.
 * Fixed filenames and counter keys keep the local scrape surface bounded.
 * Rename a private staging file so readers see complete JSON, and an existing
 * destination symlink is replaced rather than followed or truncated.
 */
export function writeLocalStats(
  command: 'watch' | 'send',
  counters: object,
  runDir?: string,
): void {
  let staging: string | undefined;
  try {
    const root = resolveRunDir(runDir);
    ensurePrivateDirectory(root);
    const dir = join(root, 'stats');
    ensurePrivateDirectory(dir);
    staging = mkdtempSync(join(dir, '.snapshot-'));
    const file = join(staging, 'snapshot.json');
    ensurePrivateLogFile(file);
    writeFileSync(file, JSON.stringify({
      pluk_stats: 1,
      command,
      pid: process.pid,
      updated_at: new Date().toISOString(),
      ...counters,
    }) + '\n');
    renameSync(file, join(dir, `${command}.json`));
  } catch {
    // A read-only or unsafe run dir must never break the event stream or send.
  } finally {
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup, including when the run dir disappears mid-write.
      }
    }
  }
}
