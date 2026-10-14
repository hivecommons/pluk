// When the bundled patterns/ dir is missing, the CLI lists the inline
// BUILTIN_PATTERNS keys instead of a hand-written (drift-prone) list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PATTERNS } from '../dist/patterns.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('cmdPatterns fallback lists every BUILTIN_PATTERNS key when patterns/ is absent', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pluk-fallback-'));
  try {
    cpSync(join(root, 'dist'), join(scratch, 'dist'), { recursive: true });
    cpSync(join(root, 'package.json'), join(scratch, 'package.json'));
    const r = spawnSync(process.execPath, [join(scratch, 'dist', 'cli.js'), 'patterns', '--cli=nonesuch'], { encoding: 'utf-8' });
    const out = r.stdout + r.stderr;
    assert.match(out, /\(builtin\)/);
    for (const k of Object.keys(BUILTIN_PATTERNS)) assert.ok(out.includes(k), `missing ${k}: ${out}`);
    assert.ok(out.includes('codex') && out.includes('aider'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
