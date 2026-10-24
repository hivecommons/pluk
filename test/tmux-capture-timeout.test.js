import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxCapturePane } from '../dist/tmux.js';

test('tmuxCapturePane throws ETIMEDOUT when tmux hangs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-hung-tmux-'));
  const savedPath = process.env.PATH;
  try {
    writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexec sleep 30\n');
    chmodSync(join(dir, 'tmux'), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
    // Pass a short timeout so the test does not wait out the 5 s production default.
    assert.throws(() => tmuxCapturePane('=s:', 50), { code: 'ETIMEDOUT' });
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
