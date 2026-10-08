import {
  chmodSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const SAFE_SESSION_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Log files larger than this are rotated down to LOG_KEEP_LINES. */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Lines kept in a session log after rotation trims it. */
export const DEFAULT_LOG_KEEP_LINES = 5000;

/**
 * Session names become path segments under <runDir>/logs, so anything
 * outside this set (slashes, dots, colons, spaces) can escape the private run dir.
 */
export function validateSessionName(session: string): void {
  if (!SAFE_SESSION_PATTERN.test(session)) {
    throw new Error(`Unsafe session name "${session}". Use only letters, numbers, underscore, and dash.`);
  }
}

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

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `PLUK_LOG_MAX_BYTES` overrides {@link DEFAULT_LOG_MAX_BYTES} when set to a positive number. */
export function logMaxBytes(): number {
  return envPositiveInt('PLUK_LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES);
}

/** `PLUK_LOG_KEEP_LINES` overrides {@link DEFAULT_LOG_KEEP_LINES} when set to a positive number. */
export function logKeepLines(): number {
  return envPositiveInt('PLUK_LOG_KEEP_LINES', DEFAULT_LOG_KEEP_LINES);
}

/**
 * Session event logs are append-only JSONL files written by `tmux pipe-pane`
 * through shell `>>` redirection — pluk never holds the fd, and nothing
 * rotates or caps them, so a long-running session's log (and the memory
 * `pluk sessions` uses to read it) grows without bound.
 *
 * Appends are O_APPEND writes (the kernel always seeks to EOF before
 * writing), and the log must keep its inode — a rename would orphan the
 * `>>` fd — so the file is trimmed in place on a single `r+` fd:
 *
 * 1. snapshot the content and compute the kept tail;
 * 2. overwrite the start of the file with that tail (the file never shrinks
 *    to zero, so a tailing Subscriber never sees an empty log mid-rotation);
 * 3. copy any bytes appended past the snapshot onto the end of the tail,
 *    repeating until the size stops growing;
 * 4. ftruncate to the new length.
 *
 * Only an append landing between the final size check and the ftruncate
 * (a few microseconds) can still be lost; appends after the ftruncate land
 * right after the kept tail. Called on a size threshold so normal-sized logs
 * never pay the read/rewrite cost.
 *
 * Returns whether the file was rewritten.
 */
export function rotateLogFileIfNeeded(
  file: string,
  opts: { maxBytes?: number; keepLines?: number; onSnapshot?: () => void } = {},
): boolean {
  const maxBytes = opts.maxBytes ?? logMaxBytes();
  const keepLines = opts.keepLines ?? logKeepLines();

  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;

  let snapshot: Buffer;
  try {
    snapshot = readFileSync(file);
  } catch {
    return false;
  }

  const lines = snapshot.toString('utf-8').split('\n');
  const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  const usableLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
  if (usableLines.length <= keepLines) return false;

  // A snapshot ending mid-line keeps that partial line unterminated so the
  // rest of it, copied from past the snapshot below, completes it.
  const kept = usableLines.slice(-keepLines);
  const rebuilt = Buffer.from(kept.join('\n') + (hasTrailingNewline ? '\n' : ''), 'utf-8');

  // Test seam: lets a test append between the snapshot and the rewrite.
  opts.onSnapshot?.();

  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, rebuilt, 0, rebuilt.length, 0);
    let readFrom = snapshot.length;
    let writeAt = rebuilt.length;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const end = fstatSync(fd).size;
      if (end <= readFrom) break;
      while (readFrom < end) {
        const bytesRead = readSync(fd, buf, 0, Math.min(buf.length, end - readFrom), readFrom);
        if (bytesRead === 0) break;
        writeSync(fd, buf, 0, bytesRead, writeAt);
        readFrom += bytesRead;
        writeAt += bytesRead;
      }
    }
    ftruncateSync(fd, writeAt);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, PRIVATE_FILE_MODE);
  return true;
}
