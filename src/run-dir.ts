import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
 * Because appends are O_APPEND writes (the kernel always seeks to EOF
 * before writing), it is safe to truncate the file out from under the
 * active writer: the next append lands right after whatever we just kept,
 * with no coordination and no corruption. Called on a size threshold so
 * normal-sized logs never pay the read/rewrite cost.
 *
 * Returns whether the file was rewritten.
 */
export function rotateLogFileIfNeeded(
  file: string,
  opts: { maxBytes?: number; keepLines?: number } = {},
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

  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return false;
  }

  const lines = content.split('\n');
  const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  const usableLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
  if (usableLines.length <= keepLines) return false;

  const kept = usableLines.slice(-keepLines);
  const rebuilt = kept.length ? kept.join('\n') + '\n' : '';

  writeFileSync(file, rebuilt, { mode: PRIVATE_FILE_MODE });
  chmodSync(file, PRIVATE_FILE_MODE);
  return true;
}
