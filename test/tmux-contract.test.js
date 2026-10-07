// Runs pluk's tmux seam (src/tmux.ts) against a REAL tmux server.
//
// Every other suite replaces `tmux` with a PATH shim, which pins pluk's
// argv but can never catch a change in tmux's own semantics. Two shipped
// regressions were exactly that class: pipe-pane's `-o` toggling logging
// off on a repeat attach (#105), and `-t name` resolving by prefix (#169).
// This file pins the contract tmux actually honours, on a private server
// (TMUX_TMPDIR) so it never touches the developer's own sessions.
//
// Skipped when no tmux binary is on PATH (the ubuntu-latest runner image
// ships without one), so CI is unaffected until tmux is installed there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  exactTarget,
  tmuxCapturePane,
  tmuxHasSession,
  tmuxListSessionNames,
  tmuxNewSession,
  tmuxPipePane,
} from '../dist/tmux.js';
import { send } from '../dist/send.js';

function hasTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = hasTmux() ? false : 'tmux is not installed';

const PREFIX = `pluk-ct-${process.pid}`;
const SHORT = `${PREFIX}-agent`; // a strict prefix of LONG
const LONG = `${PREFIX}-agent-two`;

let scratch;
const savedEnv = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };

// A detached server gives new windows 80 columns; widen them so a long
// shell prompt plus typed text never wraps and splits an asserted string.
function widen(session) {
  execFileSync('tmux', ['resize-window', '-t', `=${session}:`, '-x', '200', '-y', '50'], { stdio: 'ignore' });
}

function rawCapture(session) {
  return execFileSync('tmux', ['capture-pane', '-p', '-t', `=${session}:`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function rawSendLine(session, text) {
  execFileSync('tmux', ['send-keys', '-l', '-t', `=${session}:`, '--', text], { stdio: 'ignore' });
  execFileSync('tmux', ['send-keys', '-t', `=${session}:`, 'Enter'], { stdio: 'ignore' });
}

async function waitFor(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

before(() => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'pluk-tmux-contract-'));
  // Private server socket; and make sure tmux never thinks we are nested.
  process.env.TMUX_TMPDIR = scratch;
  delete process.env.TMUX;
  tmuxNewSession(LONG, scratch);
  widen(LONG);
});

after(() => {
  if (skip) return;
  try {
    execFileSync('tmux', ['kill-server'], { stdio: 'ignore' });
  } catch {
    // no server left to kill
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratch, { recursive: true, force: true });
});

test('tmuxHasSession does not match a session by prefix (#169)', { skip }, () => {
  assert.equal(tmuxHasSession(LONG), true);
  // A bare `-t name` would resolve SHORT to LONG by prefix; `=` must not.
  assert.equal(tmuxHasSession(SHORT), false);
});

test('tmuxNewSession + tmuxListSessionNames round-trip the exact names', { skip }, () => {
  tmuxNewSession(SHORT, scratch);
  widen(SHORT);
  const names = tmuxListSessionNames();
  assert.ok(names.includes(SHORT), `expected ${SHORT} in ${names}`);
  assert.ok(names.includes(LONG), `expected ${LONG} in ${names}`);
});

test('tmuxCapturePane(exactTarget(session)) returns the rendered frame', { skip }, async () => {
  const marker = `${PREFIX}-frame`;
  rawSendLine(SHORT, `echo ${marker}`);
  await waitFor(() => rawCapture(SHORT).split('\n').includes(marker), 'echo output in pane');
  const frame = tmuxCapturePane(exactTarget(SHORT));
  assert.ok(frame.split('\n').includes(marker), `frame did not contain ${marker}:\n${frame}`);
});

test('send() with enter types the text and the shell executes it', { skip }, async () => {
  const marker = `${PREFIX}-sent`;
  send({ session: SHORT, text: `echo ${marker}`, enter: true });
  await waitFor(() => rawCapture(SHORT).split('\n').includes(marker), 'sent command output');
});

test('send() literal keeps leading dashes and the word Enter as text', { skip }, async () => {
  const text = `echo -n Enter ${PREFIX}-lit`;
  send({ session: SHORT, text, literal: true });
  const frame = await waitFor(() => {
    const f = rawCapture(SHORT);
    return f.includes(text) ? f : null;
  }, 'literal text typed into the pane');
  // Nothing ran: `-n` was not eaten as a flag, `Enter` was typed rather than
  // pressed, so the echo output never appears on a line of its own.
  assert.ok(!frame.split('\n').includes(`Enter ${PREFIX}-lit`), `literal text was executed:\n${frame}`);
  execFileSync('tmux', ['send-keys', '-t', `=${SHORT}:`, 'C-u'], { stdio: 'ignore' });
});

test('a repeat tmuxPipePane keeps piping instead of toggling the pipe off (#105)', { skip }, async () => {
  const first = join(scratch, 'pipe-1.log');
  const second = join(scratch, 'pipe-2.log');
  tmuxPipePane(SHORT, `cat >> '${first}'`);
  tmuxPipePane(SHORT, `cat >> '${second}'`);
  const marker = `${PREFIX}-piped`;
  rawSendLine(SHORT, `echo ${marker}`);
  await waitFor(() => {
    try {
      return readFileSync(second, 'utf-8').includes(marker);
    } catch {
      return false;
    }
  }, 'pane output in the second pipe');
});
