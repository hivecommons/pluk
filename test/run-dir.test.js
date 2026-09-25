import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultRunDir,
  resolveRunDir,
  ensurePrivateDirectory,
  ensurePrivateLogFile,
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
