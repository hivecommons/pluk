// Pins the log-rotation boundaries in src/run-dir.ts that the nightly
// mutation run left unasserted: the exact-maxBytes no-op, the byte cap
// counting the trailing newline, the "fits exactly" tail, the >64 KiB
// mid-rotation append, the 0 env override, the literal defaults and the
// post-rotation mode reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, lstatSync, chmodSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rotateLogFileIfNeeded,
  logMaxBytes,
  logKeepLines,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_KEEP_LINES,
} from '../dist/run-dir.js';

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tempBase() {
  return mkdtempSync(join(tmpdir(), 'pluk-rotate-bounds-'));
}

// Every line is exactly 8 bytes, 9 with its newline, so byte budgets below
// are whole line counts: N lines == 9 * N bytes.
const LINE_BYTES = 9;
function fixedLines(count) {
  return Array.from({ length: count }, (_, i) => `{"n":${String(i).padStart(2, '0')}}`);
}

test('rotation defaults are the documented literals (10 MiB, 5000 lines)', () => {
  assert.equal(DEFAULT_LOG_MAX_BYTES, 10485760);
  assert.equal(DEFAULT_LOG_KEEP_LINES, 5000);
});

test('PLUK_LOG_MAX_BYTES=0 / PLUK_LOG_KEEP_LINES=0 are not positive overrides', () => {
  withEnv({ PLUK_LOG_MAX_BYTES: '0', PLUK_LOG_KEEP_LINES: '0' }, () => {
    assert.equal(logMaxBytes(), DEFAULT_LOG_MAX_BYTES);
    assert.equal(logKeepLines(), DEFAULT_LOG_KEEP_LINES);
  });
});

test('rotateLogFileIfNeeded leaves a log of exactly maxBytes untouched and rotates at one byte less', () => {
  const base = tempBase();
  try {
    const file = join(base, 'exact.jsonl');
    const lines = fixedLines(20);
    const content = lines.join('\n') + '\n';
    writeFileSync(file, content);
    const size = Buffer.byteLength(content);
    assert.equal(size, 20 * LINE_BYTES);

    assert.equal(rotateLogFileIfNeeded(file, { maxBytes: size, keepLines: 5 }), false);
    assert.equal(readFileSync(file, 'utf-8'), content);

    assert.equal(rotateLogFileIfNeeded(file, { maxBytes: size - 1, keepLines: 5 }), true);
    assert.equal(readFileSync(file, 'utf-8'), lines.slice(-5).join('\n') + '\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded keeps a tail that fits maxBytes exactly without dropping a line', () => {
  const base = tempBase();
  try {
    const file = join(base, 'fits.jsonl');
    const lines = fixedLines(100);
    writeFileSync(file, lines.join('\n') + '\n');

    // keepLines lines including the trailing newline are exactly maxBytes.
    const keepLines = 10;
    const maxBytes = keepLines * LINE_BYTES;
    assert.equal(rotateLogFileIfNeeded(file, { maxBytes, keepLines }), true);

    const content = readFileSync(file, 'utf-8');
    assert.equal(Buffer.byteLength(content), maxBytes);
    assert.equal(content, lines.slice(-keepLines).join('\n') + '\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded counts the trailing newline toward maxBytes', () => {
  const base = tempBase();
  try {
    const file = join(base, 'newline.jsonl');
    const lines = fixedLines(100);
    writeFileSync(file, lines.join('\n') + '\n');

    // Without the trailing newline the tail is exactly maxBytes; with it the
    // tail is one byte over, so exactly one more line must go.
    const keepLines = 10;
    const maxBytes = keepLines * LINE_BYTES - 1;
    assert.equal(rotateLogFileIfNeeded(file, { maxBytes, keepLines }), true);

    const content = readFileSync(file, 'utf-8');
    assert.ok(Buffer.byteLength(content) <= maxBytes);
    assert.equal(content, lines.slice(-(keepLines - 1)).join('\n') + '\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded copies a mid-rotation append larger than its 64 KiB read buffer', () => {
  const base = tempBase();
  try {
    const file = join(base, 'big-append.jsonl');
    const lines = fixedLines(50);
    writeFileSync(file, lines.join('\n') + '\n');

    const late = Array.from({ length: 3 }, (_, i) => `{"late":${i},"pad":"${'x'.repeat(40 * 1024)}"}`);
    const appended = late.map(l => l + '\n').join('');
    assert.ok(Buffer.byteLength(appended) > 64 * 1024);

    const rotated = rotateLogFileIfNeeded(file, {
      maxBytes: 200,
      keepLines: 5,
      onSnapshot: () => appendFileSync(file, appended),
    });
    assert.equal(rotated, true);
    assert.equal(readFileSync(file, 'utf-8'), lines.slice(-5).join('\n') + '\n' + appended);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded resets a loosened log back to 0600 after rewriting it', () => {
  const base = tempBase();
  try {
    const file = join(base, 'loose.jsonl');
    writeFileSync(file, fixedLines(50).join('\n') + '\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    assert.equal(lstatSync(file).mode & 0o777, 0o644);

    assert.equal(rotateLogFileIfNeeded(file, { maxBytes: 200, keepLines: 5 }), true);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
