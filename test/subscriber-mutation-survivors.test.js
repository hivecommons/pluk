// Pins behaviour in src/subscriber.ts that the first complete nightly
// mutation report for the file (shards 1-200 at 66.97%, 201-9999 at 63.64%)
// showed as unasserted. Most survivors there are verbose-log text, poll
// timing or defensive arms with no observable effect; each test here fails
// on a specific surviving mutant that changes what a subscriber delivers:
//   - seedResumeMarker trusting the unterminated trailing line as the resume
//     marker (`lines.pop()` deleted): a rotation before that line completes
//     then finds no marker and replays the whole kept tail
//   - seedResumeMarker's blank-line skip (`lines[i].trim()` → `lines[i]`,
//     `i--` → `i++`): a whitespace-only final line either becomes the
//     marker (replay on rotation) or runs the scan off the end of the array
//   - consumeLine's whitespace-only skip (`!line.trim()` → `!line`): the
//     line is otherwise counted as read and malformed
//   - the verbose default (`?? false` → `?? true`): a subscriber constructed
//     without `verbose` must stay silent on stderr
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subscriber } from '../dist/subscriber.js';

function makeRunDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-sub-mut-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

// Built once per test so the rewritten log carries byte-identical lines; the
// resume marker is matched by exact string, as `pluk watch` rotation keeps
// the original lines verbatim.
function seqLine(seq, type = 'raw_output') {
  return JSON.stringify({
    v: 1, ts: '2026-01-01T00:00:00.000Z', seq, pid: 1,
    session: 's', pane: 'p', source: 't', type, data: {},
  }) + '\n';
}

function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('waitFor timeout')); }
    }, intervalMs);
  });
}

function startTail(dir, session, opts = {}) {
  const events = [];
  const sub = new Subscriber({ session, runDir: dir, ...opts });
  sub.on('event', e => events.push(e));
  const done = sub.start();
  return { sub, events, done };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('resume marker: an unterminated trailing line is not used as the marker', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'mut-partial.jsonl');
  const lines = Array.from({ length: 5 }, (_, i) => seqLine(i));
  const half = seqLine(5, 'error');
  // Attach at EOF while line 5 is still being written. The marker must be
  // line 4 — the last *complete* line — not the fragment of line 5.
  writeFileSync(log, lines.join('') + half.slice(0, 12));
  const { sub, events, done } = startTail(dir, 'mut-partial');
  try {
    await sleep(300);
    assert.equal(events.length, 0);
    // Rotation before line 5 completes: the kept tail still holds line 4.
    writeFileSync(log, lines[3] + lines[4] + seqLine(9, 'bypass_permissions'));
    await waitFor(() => events.length >= 1);
    await sleep(300);
    assert.deepEqual(events.map(e => e.seq), [9], 'only the line after the marker is delivered; the kept tail is not replayed');
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume marker: a whitespace-only final line is skipped when seeding', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'mut-blank.jsonl');
  const lines = Array.from({ length: 3 }, (_, i) => seqLine(i));
  writeFileSync(log, lines.join('') + '   \n');
  const { sub, events, done } = startTail(dir, 'mut-blank');
  try {
    await sleep(300);
    assert.equal(events.length, 0);
    // Rotation drops the blank line: if it had been taken as the marker, no
    // match is found and lines 1 and 2 are delivered a second time.
    writeFileSync(log, lines[1] + lines[2] + seqLine(9, 'bypass_permissions'));
    await waitFor(() => events.length >= 1);
    await sleep(300);
    assert.deepEqual(events.map(e => e.seq), [9]);
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('whitespace-only lines are neither counted as read nor as malformed', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'mut-ws.jsonl');
  writeFileSync(log, seqLine(0, 'error') + '   \n\t\n' + seqLine(1, 'rate_limit'));
  const { sub, events, done } = startTail(dir, 'mut-ws', { fromBeginning: true });
  try {
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events.map(e => e.type), ['error', 'rate_limit']);
    assert.deepEqual(sub.stats(), { linesRead: 2, malformedLines: 0, eventsFiltered: 0, eventsEmitted: 2 });
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a subscriber constructed without verbose writes nothing to stderr', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'mut-quiet.jsonl');
  writeFileSync(log, seqLine(0, 'error'));
  const written = [];
  const orig = console.error;
  console.error = (msg) => written.push(String(msg));
  const { sub, events, done } = startTail(dir, 'mut-quiet', { fromBeginning: true });
  try {
    await waitFor(() => events.length >= 1);
    assert.deepEqual(written.filter(l => l.includes('[pluk:sub]')), []);
  } finally {
    console.error = orig;
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});
