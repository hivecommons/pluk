import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/auto-release.yml', import.meta.url), 'utf8');
// Execute the actual workflow shell, without invoking git remotes or GitHub.
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

test('auto-release decision step: invalid version, existing tag, remote errors, changelog gate', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pluk-auto-release-'));
  const output = join(cwd, 'github-output');
  const script = step('Decide whether this version needs a release').replaceAll('/tmp/auto-release-notes.md', 'auto-release-notes.md');
  const run = ({ version, changelog = '', lsRemote = 2 }) => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(cwd, 'CHANGELOG.md'), changelog);
    writeFileSync(output, '');
    return spawnSync('bash', ['-c', `
      git() { printf 'git %s\\n' "$*" >&2; return ${lsRemote}; }
      ${script}
    `], { cwd, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
  };
  try {
    // Malformed versions never reach the remote.
    for (const version of ['1.2', 'v1.2.3', '1.2.3.4', '1.2.x', '']) {
      const r = run({ version });
      assert.notEqual(r.status, 0, version);
      assert.match(r.stdout, /::error::Invalid package version/);
      assert.doesNotMatch(r.stderr, /git ls-remote/);
      assert.deepEqual(outputs(output), {});
    }

    // Tag already on origin: no release, even with release notes present.
    let r = run({ version: '0.10.0', changelog: '## 0.10.0\n\n- notes\n', lsRemote: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /v0\.10\.0 already exists; nothing to release/);
    assert.deepEqual(outputs(output), { tag: 'v0.10.0', release: 'false' });
    assert.match(r.stderr, /git ls-remote --exit-code --tags origin refs\/tags\/v0\.10\.0/);

    // ls-remote exit codes other than 2 are network/auth faults, not "no tag".
    for (const lsRemote of [1, 128]) {
      r = run({ version: '0.10.0', changelog: '## 0.10.0\n\n- notes\n', lsRemote });
      assert.equal(r.status, lsRemote);
      assert.deepEqual(outputs(output), { tag: 'v0.10.0' });
    }

    // No tag yet + nonempty section => release, with the exact section extracted.
    for (const header of ['## 0.10.0 - 2026-10-13', '## 0.10.0']) {
      r = run({ version: '0.10.0', changelog: `## 0.10.01\nwrong\n${header}\n\n### Added\n- curated\n\n## 0.9.0\nold\n` });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(outputs(output), { tag: 'v0.10.0', release: 'true' });
      assert.equal(readFileSync(join(cwd, 'auto-release-notes.md'), 'utf8'), '\n### Added\n- curated\n\n');
    }

    // Prerelease/build identifiers are accepted and tagged verbatim.
    r = run({ version: '1.0.0-rc.1+build.5', changelog: '## 1.0.0-rc.1+build.5\n- rc\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(outputs(output), { tag: 'v1.0.0-rc.1+build.5', release: 'true' });

    // No tag yet but missing/empty/prefix-only CHANGELOG section => skip, exit 0.
    for (const changelog of ['## 0.10.01\nwrong\n', '## 0.10.0\n\n  \n## 0.9.0\nold\n', '']) {
      r = run({ version: '0.10.0', changelog });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /::notice::No nonempty CHANGELOG section for 0\.10\.0; not tagging/);
      assert.deepEqual(outputs(output), { tag: 'v0.10.0', release: 'false' });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('auto-release tag and dispatch steps address the decided tag and the current SHA', () => {
  const env = {
    ...process.env, TAG: 'v0.10.0', GITHUB_REPOSITORY: 'hivecommons/pluk', GITHUB_SHA: 'abc123',
  };
  const stub = `gh() { printf '%s\\n' "$@"; }`;

  let r = spawnSync('bash', ['-e', '-c', `${stub}\n${step('Create tag')}`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'api\n-X\nPOST\nrepos/hivecommons/pluk/git/refs\n-f\nref=refs/tags/v0.10.0\n-f\nsha=abc123\n');

  r = spawnSync('bash', ['-e', '-c', `${stub}\n${step('Dispatch publish.yml on the tag')}`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'workflow\nrun\npublish.yml\n--repo\nhivecommons/pluk\n--ref\nrefs/tags/v0.10.0\n');

  // Both steps are gated on the decision step; the gate must read its release output.
  assert.equal((workflow.match(/if: steps\.version\.outputs\.release == 'true'/g) ?? []).length, 2);
});
