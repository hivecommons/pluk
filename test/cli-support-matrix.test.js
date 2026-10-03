// Guards the CLI support matrix: every CLI a user can select with
// `pluk attach --cli=<name>` must have a bundled patterns/<name>.patterns
// file, otherwise getPatterns() returns an all-null PatternSet and the
// classifier silently emits nothing for that session. That is exactly how
// codex/aider shipped broken (#135): attach.ts offered them in CLI_COMMANDS
// while patterns/ had no file for either, and no test tied the two together.
//
// CLI_COMMANDS and DANGEROUS_FLAGS are function-local constants in
// src/attach.ts, so this test extracts their keys from the source text the
// same way the BUILTIN_PATTERNS drift guard compares inline constants to the
// bundled files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAvailableCLIs, bundledPatternsDir, getPatterns, BUILTIN_PATTERNS } from '../dist/patterns.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const attachSource = readFileSync(join(repoRoot, 'src', 'attach.ts'), 'utf-8');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');

// Keys of a `const NAME: Record<string, string> = { key: 'value', ... }`
// literal in attach.ts.
function recordKeys(source, name) {
  const re = new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\};`);
  const m = source.match(re);
  assert.ok(m, `src/attach.ts should still declare ${name} as a Record<string, string> literal`);
  const keys = [...m[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*:/gm)].map((k) => k[1]);
  assert.ok(keys.length > 0, `${name} should declare at least one CLI`);
  return keys;
}

// CLI names from the README option table row `| \`--cli=claude\` | CLI type: \`a\`, \`b\` ... |`.
function readmeCliNames(text) {
  const row = text.split('\n').find((l) => l.startsWith('| `--cli=') && /CLI type:/.test(l));
  assert.ok(row, 'README.md should document the --cli option in the options table');
  const after = row.slice(row.indexOf('CLI type:'));
  const names = [...after.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'README --cli row should list at least one CLI');
  return names;
}

const bundled = listAvailableCLIs(bundledPatternsDir()).sort();

test('every CLI attach can launch (CLI_COMMANDS) has a bundled patterns file', () => {
  const launchable = recordKeys(attachSource, 'CLI_COMMANDS');
  for (const cli of launchable) {
    assert.ok(
      bundled.includes(cli),
      `attach.ts offers --cli=${cli} but patterns/${cli}.patterns is missing; ` +
        `pluk watch would classify nothing for that session (see #135)`,
    );
  }
});

test('every CLI attach can launch has a non-empty idle pattern through getPatterns', () => {
  // The bundled file existing is not enough — it must actually resolve to a
  // usable PatternSet, since an empty or comment-only file also yields nulls.
  for (const cli of recordKeys(attachSource, 'CLI_COMMANDS')) {
    const p = getPatterns(cli);
    assert.ok(p.idle instanceof RegExp, `${cli}: idle pattern should resolve from bundled patterns`);
    assert.ok(p.error instanceof RegExp, `${cli}: error pattern should resolve from bundled patterns`);
  }
});

test('every CLI with a --dangerous flag is also launchable via CLI_COMMANDS', () => {
  const launchable = recordKeys(attachSource, 'CLI_COMMANDS');
  for (const cli of recordKeys(attachSource, 'DANGEROUS_FLAGS')) {
    assert.ok(launchable.includes(cli), `DANGEROUS_FLAGS has ${cli} but CLI_COMMANDS does not`);
  }
});

test('every CLI the README advertises for --cli has a bundled patterns file', () => {
  for (const cli of readmeCliNames(readme)) {
    assert.ok(bundled.includes(cli), `README advertises --cli=${cli} but patterns/${cli}.patterns is missing`);
  }
});

test('README --cli row, CLI_COMMANDS, and bundled patterns agree on the supported set', () => {
  const launchable = recordKeys(attachSource, 'CLI_COMMANDS').sort();
  assert.deepEqual(readmeCliNames(readme).sort(), launchable, 'README --cli row should list exactly the CLIs attach can launch');
  assert.deepEqual(bundled, launchable, 'patterns/ should bundle exactly the CLIs attach can launch');
  assert.deepEqual(Object.keys(BUILTIN_PATTERNS).sort(), launchable, 'BUILTIN_PATTERNS should cover exactly the CLIs attach can launch');
});
