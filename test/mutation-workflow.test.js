import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/mutation.yml', import.meta.url), 'utf8');

// Execute the actual workflow shell against a scratch git repository.
function step(name) {
  const section = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(section, `missing step: ${name}`);
  return section.split('        run: |\n')[1]
    .split('\n').reduce((lines, line) => {
      if (lines.done) return lines;
      if (line.startsWith('          ')) lines.push(line.slice(10));
      else lines.done = true;
      return lines;
    }, []).join('\n');
}

function outputs(file) {
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
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
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', step('Select files to mutate (one matrix entry per file)')], {
    cwd,
    env: { ...process.env, GITHUB_OUTPUT: output, ...env },
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

test('mutation job only runs when the select step produced files', () => {
  assert.match(workflow, /\n  mutation:\n    needs: select\n    if: needs\.select\.outputs\.files != '\[\]'\n/);
  assert.match(workflow, /file: \$\{\{ fromJSON\(needs\.select\.outputs\.files\) \}\}/);
});
