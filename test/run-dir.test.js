import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, lstatSync, chmodSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultRunDir,
  resolveRunDir,
  ensurePrivateDirectory,
  ensurePrivateLogFile,
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
  return mkdtempSync(join(tmpdir(), 'pluk-rundir-test-'));
}

test('defaultRunDir prefers XDG_RUNTIME_DIR', () => {
  withEnv({ XDG_RUNTIME_DIR: '/run/user/1234' }, () => {
    assert.strictEqual(defaultRunDir(), join('/run/user/1234', 'pluk'));
  });
});

test('defaultRunDir falls back to uid-scoped tmpdir without XDG_RUNTIME_DIR', () => {
  withEnv({ XDG_RUNTIME_DIR: undefined }, () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    assert.strictEqual(defaultRunDir(), join(tmpdir(), `pluk-${uid}`));
  });
});

test('resolveRunDir precedence: explicit arg > PLUK_RUN_DIR > default', () => {
  withEnv({ PLUK_RUN_DIR: '/env/dir', XDG_RUNTIME_DIR: '/run/user/1' }, () => {
    assert.strictEqual(resolveRunDir('/explicit'), '/explicit');
    assert.strictEqual(resolveRunDir(), '/env/dir');
  });
  withEnv({ PLUK_RUN_DIR: undefined, XDG_RUNTIME_DIR: '/run/user/1' }, () => {
    assert.strictEqual(resolveRunDir(), join('/run/user/1', 'pluk'));
  });
});

test('ensurePrivateDirectory creates a fresh dir with 0700', () => {
  const base = tempBase();
  try {
    const dir = join(base, 'nested', 'run');
    ensurePrivateDirectory(dir);
    const info = lstatSync(dir);
    assert.ok(info.isDirectory());
    assert.strictEqual(info.mode & 0o777, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateDirectory tightens permissions on an existing dir', () => {
  const base = tempBase();
  try {
    const dir = join(base, 'loose');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDirectory(dir);
    assert.strictEqual(lstatSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateDirectory refuses a symlinked directory', () => {
  const base = tempBase();
  try {
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);
    assert.throws(() => ensurePrivateDirectory(link), /symlinked directory/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateDirectory refuses a non-directory path', () => {
  const base = tempBase();
  try {
    const file = join(base, 'plainfile');
    writeFileSync(file, 'x');
    assert.throws(() => ensurePrivateDirectory(file), /non-directory path/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateLogFile creates a fresh file with 0600', () => {
  const base = tempBase();
  try {
    const file = join(base, 'session.jsonl');
    ensurePrivateLogFile(file);
    const info = lstatSync(file);
    assert.ok(info.isFile());
    assert.strictEqual(info.mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateLogFile tightens permissions on an existing file', () => {
  const base = tempBase();
  try {
    const file = join(base, 'loose.jsonl');
    writeFileSync(file, 'line\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    ensurePrivateLogFile(file);
    assert.strictEqual(lstatSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateLogFile refuses a symlinked log file', () => {
  const base = tempBase();
  try {
    const real = join(base, 'real.jsonl');
    writeFileSync(real, '');
    const link = join(base, 'link.jsonl');
    symlinkSync(real, link);
    assert.throws(() => ensurePrivateLogFile(link), /symlinked log file/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateLogFile refuses a directory at the log path', () => {
  const base = tempBase();
  try {
    const dir = join(base, 'dir.jsonl');
    mkdirSync(dir);
    assert.throws(() => ensurePrivateLogFile(dir), /non-file log path/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The ownership checks compare lstat's uid against process.getuid() at call
// time, so faking getuid() makes the real (self-owned) path look foreign —
// no root or second user needed to pin the refusal branches.
function withFakeUid(fn) {
  const original = process.getuid;
  if (typeof original !== 'function') return; // platform without uids
  process.getuid = () => original.call(process) + 1;
  try {
    fn();
  } finally {
    process.getuid = original;
  }
}

test('ensurePrivateDirectory refuses a directory owned by another user', () => {
  const base = tempBase();
  try {
    const dir = join(base, 'foreign');
    mkdirSync(dir, { mode: 0o700 });
    withFakeUid(() => {
      assert.throws(() => ensurePrivateDirectory(dir), /not owned by current user/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensurePrivateLogFile refuses a log file owned by another user', () => {
  const base = tempBase();
  try {
    const file = join(base, 'foreign.jsonl');
    writeFileSync(file, '');
    chmodSync(file, 0o600);
    withFakeUid(() => {
      assert.throws(() => ensurePrivateLogFile(file), /not owned by current user/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('logMaxBytes/logKeepLines fall back to the documented defaults', () => {
  withEnv({ PLUK_LOG_MAX_BYTES: undefined, PLUK_LOG_KEEP_LINES: undefined }, () => {
    assert.strictEqual(logMaxBytes(), DEFAULT_LOG_MAX_BYTES);
    assert.strictEqual(logKeepLines(), DEFAULT_LOG_KEEP_LINES);
  });
});

test('logMaxBytes/logKeepLines honor positive env overrides and ignore garbage', () => {
  withEnv({ PLUK_LOG_MAX_BYTES: '2048', PLUK_LOG_KEEP_LINES: '10' }, () => {
    assert.strictEqual(logMaxBytes(), 2048);
    assert.strictEqual(logKeepLines(), 10);
  });
  withEnv({ PLUK_LOG_MAX_BYTES: 'not-a-number', PLUK_LOG_KEEP_LINES: '-5' }, () => {
    assert.strictEqual(logMaxBytes(), DEFAULT_LOG_MAX_BYTES);
    assert.strictEqual(logKeepLines(), DEFAULT_LOG_KEEP_LINES);
  });
});

test('rotateLogFileIfNeeded leaves a log under the byte threshold untouched', () => {
  const base = tempBase();
  try {
    const file = join(base, 'small.jsonl');
    const content = '{"ts":"1"}\n{"ts":"2"}\n';
    writeFileSync(file, content);
    const rotated = rotateLogFileIfNeeded(file, { maxBytes: 1024, keepLines: 5 });
    assert.strictEqual(rotated, false);
    assert.strictEqual(readFileSync(file, 'utf-8'), content);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded trims an oversized log to the last N lines', () => {
  const base = tempBase();
  try {
    const file = join(base, 'big.jsonl');
    const lines = Array.from({ length: 100 }, (_, i) => `{"ts":"${i}"}`);
    writeFileSync(file, lines.join('\n') + '\n');

    const rotated = rotateLogFileIfNeeded(file, { maxBytes: 10, keepLines: 10 });
    assert.strictEqual(rotated, true);

    const kept = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
    assert.deepEqual(kept, lines.slice(-10));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded is a no-op for a missing file', () => {
  const base = tempBase();
  try {
    const file = join(base, 'missing.jsonl');
    assert.strictEqual(rotateLogFileIfNeeded(file, { maxBytes: 1 }), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded leaves an oversized but unreadable log alone', (t) => {
  // stat succeeds (size over the threshold) but the read fails: the watcher
  // must neither throw nor touch the file. chmod is advisory for root, so
  // the branch cannot be reached there.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: chmod 000 does not make the file unreadable');
    return;
  }
  const base = tempBase();
  try {
    const file = join(base, 'unreadable.jsonl');
    const original = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n') + '\n';
    writeFileSync(file, original);
    chmodSync(file, 0o000);
    try {
      assert.strictEqual(rotateLogFileIfNeeded(file, { maxBytes: 10, keepLines: 5 }), false);
    } finally {
      chmodSync(file, 0o600);
    }
    assert.strictEqual(readFileSync(file, 'utf-8'), original, 'file must be left untouched');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rotateLogFileIfNeeded keeps appends intact afterward (O_APPEND safety)', () => {
  const base = tempBase();
  try {
    const file = join(base, 'append-after-rotate.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => `{"ts":"${i}"}`);
    writeFileSync(file, lines.join('\n') + '\n');

    assert.strictEqual(rotateLogFileIfNeeded(file, { maxBytes: 10, keepLines: 5 }), true);

    const fd = openSync(file, 'a');
    writeSync(fd, '{"ts":"new"}\n');
    closeSync(fd);

    const kept = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
    assert.deepEqual(kept, [...lines.slice(-5), '{"ts":"new"}']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
