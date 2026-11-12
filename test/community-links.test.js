// Guards the community entry points in the README, the issue chooser and
// CONTRIBUTING.md so they stay in step with the hivecommons/hive README
// Community line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const TEMPLATES = join(ROOT, '.github', 'ISSUE_TEMPLATE');
const CHOOSER = readFileSync(join(TEMPLATES, 'config.yml'), 'utf8');
const CONTRIBUTING = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
const ISSUES = 'https://github.com/hivecommons/pluk/issues';
const chooserUrls = [...CHOOSER.matchAll(/^\s+url:[ \t]*(\S+)$/gm)].map((m) => m[1]);

const COMMUNITY_LINKS = [
  ['Discord', 'https://hivecommons.dev/discord'],
  ['Twitch live stream', 'https://www.twitch.tv/hivecommons'],
  ['community meeting', 'https://docs.hivecommons.dev/docs/community/meetings'],
];

for (const [name, url] of COMMUNITY_LINKS) {
  test(`README links the Hive Commons ${name}`, () => {
    assert.ok(README.includes(`](${url})`), `README.md is missing ${url}`);
  });

  test(`issue chooser links the Hive Commons ${name}`, () => {
    assert.ok(chooserUrls.includes(url), `.github/ISSUE_TEMPLATE/config.yml is missing ${url}`);
  });
}

for (const label of ['good+first+issue', 'help+wanted']) {
  test(`CONTRIBUTING.md links open "${label.replace(/\+/g, ' ')}" issues`, () => {
    const url = `${ISSUES}?q=is%3Aissue+is%3Aopen+label%3A%22${label}%22`;
    assert.ok(CONTRIBUTING.includes(`](${url})`), `CONTRIBUTING.md is missing ${url}`);
  });
}

test('CONTRIBUTING.md links every issue form, and each linked form exists', () => {
  const forms = [...CONTRIBUTING.matchAll(/\(https:\/\/github\.com\/hivecommons\/pluk\/issues\/new\?template=([^)\s]+)\)/g)].map((m) => m[1]);
  for (const form of ['pattern_request.yml', 'bug_report.yml', 'feature_request.yml']) {
    assert.ok(forms.includes(form), `CONTRIBUTING.md must link the ${form} issue form`);
  }
  for (const form of forms) {
    assert.ok(existsSync(join(TEMPLATES, form)), `CONTRIBUTING.md links missing issue form ${form}`);
  }
});

test('CONTRIBUTING.md links ROADMAP.md', () => {
  assert.ok(CONTRIBUTING.includes('](ROADMAP.md)'), 'CONTRIBUTING.md is missing a ROADMAP.md link');
  assert.ok(existsSync(join(ROOT, 'ROADMAP.md')), 'ROADMAP.md linked from CONTRIBUTING.md is missing');
});

for (const [name, url] of [
  ['Discord', 'https://hivecommons.dev/discord'],
  ['community meeting', 'https://docs.hivecommons.dev/docs/community/meetings'],
]) {
  test(`CONTRIBUTING.md links the Hive Commons ${name}`, () => {
    assert.ok(CONTRIBUTING.includes(`](${url})`), `CONTRIBUTING.md is missing ${url}`);
  });
}
