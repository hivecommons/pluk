import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { step, outputs } from './helpers/workflow-steps.js';

const workflow = readFileSync(new URL('../.github/workflows/mutation.yml', import.meta.url), 'utf8');

// Execute the actual workflow shell against a scratch git repository.
const isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: isolatedEnv });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function commitAll(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
}

// Base branch: two sources, one test file. PR branch: edits a.ts, deletes
// b.ts, adds c.ts with its test, touches a non-src file and a nested test.
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'pluk-mutation-select-'));
  git(cwd, 'init', '-q', '-b', 'main');
  mkdirSync(join(cwd, 'src', 'nested'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(cwd, 'src', 'a.test.ts'), 'a\n');
  writeFileSync(join(cwd, 'src', 'nested', 'deep.ts'), 'export const d = 1;\n');
  writeFileSync(join(cwd, 'README.md'), 'base\n');
  commitAll(cwd, 'base');
  // The workflow diffs against origin/<base_ref>; point origin at the repo itself.
  git(cwd, 'remote', 'add', 'origin', cwd);
  git(cwd, 'fetch', '-q', 'origin');

  git(cwd, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 2;\n');
  rmSync(join(cwd, 'src', 'b.ts'));
  writeFileSync(join(cwd, 'src', 'c.ts'), 'export const c = 1;\n');
  writeFileSync(join(cwd, 'src', 'c.test.ts'), 'c\n');
  writeFileSync(join(cwd, 'src', 'nested', 'deep.test.ts'), 'deep\n');
  writeFileSync(join(cwd, 'README.md'), 'changed\n');
  commitAll(cwd, 'feature');
  return cwd;
}

function select(cwd, env) {
  const output = join(cwd, 'github-output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', step(workflow, 'Select files to mutate (one matrix entry per file)')], {
    cwd,
    env: { ...isolatedEnv, GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = outputs(output);
  assert.ok(out.files, `files output missing: ${r.stdout}`);
  return { files: JSON.parse(out.files), stdout: r.stdout };
}

test('mutation select step: pull_request mutates changed src files only, never deleted or test files', () => {
  const cwd = repo();
  try {
    const { files, stdout } = select(cwd, { EVENT_NAME: 'pull_request', BASE_REF: 'main' });
    // b.ts was deleted on the branch: Stryker cannot --mutate a path that no
    // longer exists, so it must not become a matrix entry (#464).
    assert.deepEqual(files, ['src/a.ts', 'src/c.ts']);
    assert.match(stdout, /Mutating: \["src\/a\.ts","src\/c\.ts"\]/);
    assert.doesNotMatch(stdout, /No changed src files/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('mutation select step: pull_request with no src changes emits [] and the skip notice', () => {
  const cwd = repo();
  try {
    git(cwd, 'checkout', '-q', 'main');
    git(cwd, 'checkout', '-q', '-b', 'docs-only');
    writeFileSync(join(cwd, 'README.md'), 'docs only\n');
    writeFileSync(join(cwd, 'src', 'a.test.ts'), 'a changed\n');
    commitAll(cwd, 'docs only');
    const { files, stdout } = select(cwd, { EVENT_NAME: 'pull_request', BASE_REF: 'main' });
    assert.deepEqual(files, []);
    assert.match(stdout, /No changed src files; skipping mutation run\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('mutation select step: schedule/dispatch mutates every tracked src file, sorted, without tests', () => {
  const cwd = repo();
  try {
    for (const EVENT_NAME of ['schedule', 'workflow_dispatch']) {
      const { files } = select(cwd, { EVENT_NAME, BASE_REF: '' });
      assert.deepEqual(files, ['src/a.ts', 'src/c.ts', 'src/nested/deep.ts'], EVENT_NAME);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('mutation select step: splits src/subscriber.ts into two line-range matrix entries', () => {
  const cwd = repo();
  try {
    git(cwd, 'checkout', '-q', 'main');
    git(cwd, 'checkout', '-q', '-b', 'subscriber-edit');
    writeFileSync(join(cwd, 'src', 'subscriber.ts'), 'export const sub = 1;\n');
    commitAll(cwd, 'touch subscriber');
    const { files: prFiles } = select(cwd, { EVENT_NAME: 'pull_request', BASE_REF: 'main' });
    assert.deepEqual(prFiles, ['src/subscriber.ts:1-205', 'src/subscriber.ts:206-9999']);

    const { files: schedFiles } = select(cwd, { EVENT_NAME: 'schedule', BASE_REF: '' });
    assert.deepEqual(schedFiles, [
      'src/a.ts',
      'src/b.ts',
      'src/nested/deep.ts',
      'src/subscriber.ts:1-205',
      'src/subscriber.ts:206-9999',
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('mutation job only runs when the select step produced files', () => {
  assert.match(workflow, /\n  mutation:\n    needs: select\n    if: needs\.select\.outputs\.files != '\[\]'\n/);
  assert.match(workflow, /file: \$\{\{ fromJSON\(needs\.select\.outputs\.files\) \}\}/);
});

// Stryker only mutates a node that lies entirely inside one --mutate line
// range, so a statement or class member crossing a range boundary would lose
// its mutants from every shard without any signal.
function lineRangeBoundaries(file) {
  const re = new RegExp(`${file.replace(/[.]/g, '\\.')}:(\\d+)-(\\d+)`, 'g');
  const ranges = [...new Set([...workflow.matchAll(re)].map((m) => m[0]))].map((r) => r.split(':')[1].split('-').map(Number));
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges.slice(1).map(([start]) => start - 1);
}

function straddlingNodes(path, boundaries) {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = [];
  const check = (node) => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    for (const b of boundaries) {
      if (start <= b && end > b) {
        if (ts.isClassLike(node)) node.members.forEach(check);
        else found.push(`${ts.SyntaxKind[node.kind]} at lines ${start}-${end} straddles the cut after line ${b}`);
      }
    }
  };
  sf.statements.forEach(check);
  return found;
}

// Inside Stryker's sandbox ../src/subscriber.ts is the instrumented copy, whose
// line layout differs from the real source, so the cut appears to straddle a
// member and the dry run aborts before any subscriber mutant is measured. A
// text guard cannot kill a mutant anyway; `npm test` still runs it (#425).
test('mutation select step: the src/subscriber.ts line-range cut does not split a statement or class member', {
  skip: process.env.PLUK_UNDER_STRYKER === '1' && 'reads src/subscriber.ts, which Stryker instruments in its sandbox',
}, () => {
  const boundaries = lineRangeBoundaries('src/subscriber.ts');
  assert.ok(boundaries.length > 0, 'expected src/subscriber.ts to be split into line ranges in mutation.yml');
  const url = new URL('../src/subscriber.ts', import.meta.url);
  assert.deepEqual(
    straddlingNodes(url.pathname, boundaries),
    [],
    'Stryker drops mutants for nodes crossing a --mutate line range; move the cut in mutation.yml to a gap between members',
  );
});

test('line-range guard flags a node that crosses the cut', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-mutation-straddle-'));
  try {
    const file = join(dir, 'x.ts');
    writeFileSync(file, 'class A {\n  m() {\n    return 1;\n  }\n  n() {}\n}\n');
    assert.deepEqual(straddlingNodes(file, [4]), []);
    assert.equal(straddlingNodes(file, [3]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
