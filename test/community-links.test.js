// Guards the community entry points in the README and the issue chooser so
// they stay in step with the hivecommons/hive README Community line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const CHOOSER = readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'utf8');
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
