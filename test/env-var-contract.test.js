import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url);
// TERM_PROGRAM and XDG_RUNTIME_DIR are implementation details, not user-facing knobs.
const IGNORED = new Set(['TERM_PROGRAM', 'XDG_RUNTIME_DIR']);

const read = new Set();
for (const file of readdirSync(SRC).filter(f => f.endsWith('.ts'))) {
  const text = readFileSync(new URL(file, SRC), 'utf8');
  for (const [, a, b] of text.matchAll(/process\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])/g)) {
    const name = a ?? b;
    if (!IGNORED.has(name) && /^(PLUK_|NO_COLOR$)/.test(name)) read.add(name);
  }
}

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = readme.split('### Environment Variables')[1].split(/^#{1,3} |^<\/details>/m)[0];
const documented = new Set([...section.matchAll(/^\| `(\w+)`/gm)].map(([, name]) => name));

test('every PLUK_*/NO_COLOR read in src/ is documented in the README', () => {
  assert.deepEqual([...read].sort(), [...documented].sort());
});
