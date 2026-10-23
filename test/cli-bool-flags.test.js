// Boolean flags given an explicit value: only true/false are accepted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let scratch;
let stubBin;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'pluk-bool-'));
  stubBin = join(scratch, 'bin');
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, 'tmux'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(stubBin, 'tmux'), 0o755);
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, NO_COLOR: '1', PATH: `${stubBin}:${process.env.PATH}` },
  });
  return { code: res.status, stderr: res.stderr ?? '' };
}

test('--enter=1 is rejected with exit 2 and a boolean hint', () => {
  const { code, stderr } = runCli(['send', 's', '--text=x', '--enter=1']);
  assert.equal(code, 2);
  assert.match(stderr, /--enter is a boolean flag: use --enter or --enter=false/);
});

test('--dangerous=on is rejected with exit 2', () => {
  const { code, stderr } = runCli(['attach', 's', '--dangerous=on']);
  assert.equal(code, 2);
  assert.match(stderr, /--dangerous is a boolean flag/);
});

test('--enter=false and --enter=true are accepted', () => {
  for (const v of ['false', 'true']) {
    const { code, stderr } = runCli(['send', 's', '--text=x', `--enter=${v}`]);
    assert.equal(code, 0, stderr);
  }
});
