import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
// Execute the actual workflow shell, without invoking npm or GitHub.
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

for (const name of ['CHANGELOG has a section for this version', 'Extract release notes from CHANGELOG.md']) {
  test(`${name}: exact version, section boundary, and missing/empty notes`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pluk-release-'));
    // Keep the guard's temporary output isolated from other test runs.
    const script = step(name).replaceAll('/tmp/release-notes.md', 'release-notes.md');
    const run = (changelog) => {
      writeFileSync(join(cwd, 'CHANGELOG.md'), changelog);
      return spawnSync('bash', ['-e', '-c', script], {
        cwd, env: { ...process.env, GITHUB_REF_NAME: 'v0.9.0' }, encoding: 'utf8',
      });
    };
    try {
      for (const header of ['## 0.9.0 - 2026-10-02', '## 0.9.0']) {
        assert.equal(run(`## 0.9.01\nwrong\n${header}\n\n### Fixed\n- curated\n\n## 0.8.0\nold\n`).status, 0);
        assert.equal(readFileSync(join(cwd, 'release-notes.md'), 'utf8'), '\n### Fixed\n- curated\n\n');
      }
      for (const content of ['## 0.9.01\nwrong\n', '## 0.9.0\n\n  \n## 0.8.0\nold\n', '']) {
        assert.notEqual(run(content).status, 0);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('release creation verifies the tag and preserves existing releases', () => {
  const script = step('Create GitHub release');
  for (const exists of [true, false]) {
    const result = spawnSync('bash', ['-e', '-c', `
      gh() {
        if [ "$2" = view ]; then return ${exists ? 0 : 1}; fi
        printf '%s\\n' "$@"
      }
      ${script}
    `], { env: { ...process.env, GITHUB_REF_NAME: 'v0.9.0' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (exists) assert.match(result.stdout, /already exists; leaving it untouched/);
    else assert.equal(result.stdout, 'release\ncreate\nv0.9.0\n--verify-tag\n--title\nv0.9.0\n--notes-file\nrelease-notes.md\n');
  }
});
