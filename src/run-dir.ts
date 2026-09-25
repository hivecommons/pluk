import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

export function defaultRunDir(): string {
  const xdgRuntimeDir = process.env['XDG_RUNTIME_DIR'];
  if (xdgRuntimeDir) return join(xdgRuntimeDir, 'pluk');

  const uid = currentUid();
  return join(tmpdir(), `pluk-${uid ?? 'user'}`);
}

export function resolveRunDir(runDir?: string): string {
  return runDir ?? process.env['PLUK_RUN_DIR'] ?? defaultRunDir();
}

export function ensurePrivateDirectory(dir: string): void {
  const uid = currentUid();

  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked directory: ${dir}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Refusing to use non-directory path: ${dir}`);
    }
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(`Refusing to use directory not owned by current user: ${dir}`);
    }
    if ((info.mode & 0o777) !== PRIVATE_DIR_MODE) {
      chmodSync(dir, PRIVATE_DIR_MODE);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const created = lstatSync(dir);
    if (created.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked directory: ${dir}`);
    }
    chmodSync(dir, PRIVATE_DIR_MODE);
  }
}

export function ensurePrivateLogFile(file: string): void {
  const uid = currentUid();

  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked log file: ${file}`);
    }
    if (!info.isFile()) {
      throw new Error(`Refusing to use non-file log path: ${file}`);
    }
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(`Refusing to use log file not owned by current user: ${file}`);
    }
    if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) {
      chmodSync(file, PRIVATE_FILE_MODE);
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const fd = openSync(file, 'a', PRIVATE_FILE_MODE);
  closeSync(fd);
  chmodSync(file, PRIVATE_FILE_MODE);
}
