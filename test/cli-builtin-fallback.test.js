// When the bundled patterns/ dir is missing, the CLI lists the inline
// BUILTIN_PATTERNS keys instead of a hand-written (drift-prone) list.
// Both call sites of that fallback — `patterns` and `watch` — are pinned
// here so neither can regress to a stale literal on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PATTERNS } from '../dist/patterns.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Copies dist/ + package.json (but NOT patterns/) into a scratch dir so
// bundledPatternsDir() resolves to a path that does not exist.
function withStrippedInstall(t, fn) {
  const scratch = mkdtempSync(join(tmpdir(), 'pluk-fallback-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  cpSync(join(root, 'dist'), join(scratch, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'));
  return fn(join(scratch, 'dist', 'cli.js'));
}

function assertListsEveryBuiltin(out) {
  assert.match(out, /\(builtin\)/);
  for (const k of Object.keys(BUILTIN_PATTERNS)) assert.ok(out.includes(k), `missing ${k}: ${out}`);
  assert.ok(out.includes('codex') && out.includes('aider'));
}

test('cmdPatterns fallback lists every BUILTIN_PATTERNS key when patterns/ is absent', t => {
  withStrippedInstall(t, cli => {
    const r = spawnSync(process.execPath, [cli, 'patterns', '--cli=nonesuch'], { encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assertListsEveryBuiltin(r.stdout + r.stderr);
  });
});

test('cmdWatch no-pattern warning lists every BUILTIN_PATTERNS key when patterns/ is absent', t => {
  withStrippedInstall(t, cli => {
    const r = spawnSync(process.execPath, [cli, 'watch', 's', '--cli=nonesuch', '--include-raw'], {
      input: 'Error: 429 rate limit\n',
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0);
    const warnings = r.stderr.match(/no pattern set for --cli=nonesuch \(bundled: [^)]*\(builtin\)\)/g);
    assert.equal(warnings?.length, 1, `expected one builtin-fallback warning, got stderr: ${r.stderr}`);
    assertListsEveryBuiltin(warnings[0]);
    assert.doesNotMatch(r.stderr, /bundled: none/, 'the pre-#240 literal must not come back');
    assert.match(r.stdout, /raw_output/);
  });
});

test('cmdWatch no-pattern warning names the bundled CLIs when patterns/ is present', () => {
  const r = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'watch', 's', '--cli=nonesuch'], {
    input: 'x\n',
    encoding: 'utf-8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no pattern set for --cli=nonesuch \(bundled: /);
  assert.doesNotMatch(r.stderr, /\(builtin\)/, 'builtin fallback must not fire when patterns/ exists');
});

test('cmdWatch emits raw_output without --include-raw when no pattern set exists', () => {
  const r = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'watch', 's', '--cli=nonesuch'], {
    input: 'hello world\n',
    encoding: 'utf-8',
  });
  assert.equal(r.status, 0);
  const events = r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'raw_output');
});
