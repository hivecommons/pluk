// Tests for src/subscriber.ts — JSONL log tailing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subscriber, subscribe } from '../dist/subscriber.js';
import { rotateLogFileIfNeeded } from '../dist/run-dir.js';

function makeRunDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-sub-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function eventLine(type, data = {}) {
  return JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: 0, pid: 1,
    session: 's', pane: 'p', source: 't', type, data,
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

test('logFile getter derives path from runDir and session', () => {
  const sub = new Subscriber({ session: 'agent7', runDir: '/some/run' });
  assert.equal(sub.logFile, join('/some/run', 'logs', 'agent7.jsonl'));
});

test('fromBeginning replays existing events then picks up appended lines', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 's1.jsonl');
  writeFileSync(log, eventLine('state_change', { to: 'working' }) + eventLine('error', { line: 'boom' }));

  const events = [];
  const sub = new Subscriber({ session: 's1', runDir: dir, fromBeginning: true });
  sub.on('event', e => events.push(e));
  const done = sub.start();

  try {
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events.map(e => e.type), ['state_change', 'error']);

    appendFileSync(log, eventLine('rate_limit'));
    await waitFor(() => events.length >= 3);
    assert.equal(events[2].type, 'rate_limit');
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default (tail) mode skips pre-existing events', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 's2.jsonl');
  writeFileSync(log, eventLine('error', { line: 'old' }));

  const events = [];
  const sub = new Subscriber({ session: 's2', runDir: dir });
  sub.on('event', e => events.push(e));
  const done = sub.start();

  try {
    // give the tail loop a moment to reach steady state, then append
    await new Promise(r => setTimeout(r, 300));
    appendFileSync(log, eventLine('state_change', { to: 'idle' }));
    await waitFor(() => events.length >= 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'state_change');
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('filter drops non-matching event types', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 's3.jsonl');
  writeFileSync(log,
    eventLine('raw_output', { line: 'noise' }) +
    eventLine('rate_limit') +
    eventLine('raw_output', { line: 'noise2' }) +
    eventLine('error', { line: 'boom' }));

  const events = [];
  const sub = new Subscriber({ session: 's3', runDir: dir, fromBeginning: true, filter: ['rate_limit', 'error'] });
  sub.on('event', e => events.push(e));
  const done = sub.start();

  try {
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events.map(e => e.type), ['rate_limit', 'error']);
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed and blank lines are skipped without stopping the tail', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 's4.jsonl');
  writeFileSync(log, 'not json\n\n' + eventLine('error') + '{"broken":\n' + eventLine('rate_limit'));

  const events = [];
  const sub = new Subscriber({ session: 's4', runDir: dir, fromBeginning: true });
  sub.on('event', e => events.push(e));
  const done = sub.start();

  try {
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events.map(e => e.type), ['error', 'rate_limit']);
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop() before the log file appears aborts the wait loop', async () => {
  const dir = makeRunDir();
  const sub = new Subscriber({ session: 'never-appears', runDir: dir });
  let errored = false;
  sub.on('error', () => { errored = true; });
  const done = sub.start();
  sub.stop();
  await done;
  assert.equal(errored, false);
  rmSync(dir, { recursive: true, force: true });
});

test('subscribe() helper wires the callback and returns a running Subscriber', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 's5.jsonl');
  writeFileSync(log, eventLine('state_change', { to: 'working' }));

  const events = [];
  const sub = subscribe('s5', e => events.push(e), { runDir: dir, fromBeginning: true });
  try {
    assert.ok(sub instanceof Subscriber);
    await waitFor(() => events.length >= 1);
    assert.equal(events[0].type, 'state_change');
  } finally {
    sub.stop();
    await new Promise(r => setTimeout(r, 250));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Subscriber rejects session names that traverse out of the run dir', () => {
  for (const session of ['../escape', '../../etc/passwd', 'a/b', 'a b', '']) {
    assert.throws(() => new Subscriber({ session }), /Unsafe session name/);
  }
});

test('subscribe() helper rejects traversal session names before starting', () => {
  assert.throws(() => subscribe('../../evil', () => {}), /Unsafe session name/);
});

test('subscribe() helper surfaces a start() rejection as an error event', async () => {
  const dir = makeRunDir();
  // A directory at the log path passes the stat() wait but makes the first
  // read() reject with EISDIR, so start() itself rejects — the helper must
  // turn that into an 'error' event rather than an unhandled rejection.
  mkdirSync(join(dir, 'logs', 's6.jsonl'));

  const sub = subscribe('s6', () => {}, { runDir: dir, fromBeginning: true });
  try {
    const err = await new Promise(resolve => sub.once('error', resolve));
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'EISDIR');
  } finally {
    sub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- rotation resilience -----------------------------------------------------
// `pluk watch` rotates the log in place (truncate + rewrite of the newest N
// lines). A tailing Subscriber must keep delivering afterwards, exactly once.

function seqLine(seq, type = 'raw_output') {
  return JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq, pid: 1,
    session: 's', pane: 'p', source: 't', type, data: {},
  }) + '\n';
}

async function startTail(dir, session, opts = {}) {
  const events = [];
  const sub = new Subscriber({ session, runDir: dir, ...opts });
  sub.on('event', e => events.push(e));
  const done = sub.start();
  return { sub, events, done };
}

test('rotation: resumes after the last delivered line and never duplicates', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'rot1.jsonl');
  writeFileSync(log, '');
  const { sub, events, done } = await startTail(dir, 'rot1');
  try {
    await waitFor(() => sub.listenerCount('event') === 1);
    await new Promise(r => setTimeout(r, 250));
    let body = '';
    for (let i = 0; i < 200; i++) body += seqLine(i);
    appendFileSync(log, body);
    await waitFor(() => events.length === 200);

    assert.equal(rotateLogFileIfNeeded(log, { maxBytes: 1000, keepLines: 50 }), true);
    appendFileSync(log, seqLine(999, 'bypass_permissions'));

    await waitFor(() => events.length >= 201);
    assert.equal(events.length, 201, 'kept lines must not be replayed');
    assert.equal(events[200].type, 'bypass_permissions');
    assert.deepEqual(new Set(events.map(e => e.seq)).size, 201, 'no duplicate events');
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation: lines appended between read and rotation are delivered once', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'rot2.jsonl');
  writeFileSync(log, '');
  const { sub, events, done } = await startTail(dir, 'rot2');
  try {
    await new Promise(r => setTimeout(r, 250));
    let body = '';
    for (let i = 0; i < 100; i++) body += seqLine(i);
    appendFileSync(log, body);
    await waitFor(() => events.length === 100);

    // Rotation keeps the newest 50 lines: 70..99 already seen + 100..119 unseen.
    let extra = '';
    for (let i = 100; i < 120; i++) extra += seqLine(i);
    appendFileSync(log, extra);
    // Only a synchronous append + rotate (no poll in between) exercises the
    // marker lookup inside the kept window.
    assert.equal(rotateLogFileIfNeeded(log, { maxBytes: 100, keepLines: 50 }), true);

    await waitFor(() => events.length >= 120);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(events.length, 120);
    assert.deepEqual(events.slice(100).map(e => e.seq), Array.from({ length: 20 }, (_, i) => 100 + i));
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation: when the last seen line was trimmed away, the whole kept tail is replayed', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'rot3.jsonl');
  writeFileSync(log, '');
  const { sub, events, done } = await startTail(dir, 'rot3');
  try {
    await new Promise(r => setTimeout(r, 250));
    let body = '';
    for (let i = 0; i < 300; i++) body += seqLine(i);
    appendFileSync(log, body);
    await waitFor(() => events.length === 300);

    // 100 more lines land and the log is rotated down to the newest 50
    // before the next poll: the last seen line (seq 299) is gone, so every
    // kept line (350..399) is unseen and must be replayed.
    let extra = '';
    for (let i = 300; i < 400; i++) extra += seqLine(i);
    appendFileSync(log, extra);
    assert.equal(rotateLogFileIfNeeded(log, { maxBytes: 10, keepLines: 50 }), true);

    await waitFor(() => events.length >= 350);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(events.length, 350);
    assert.equal(events[300].seq, 350);
    assert.equal(events[349].seq, 399);
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation: before any line was seen, the kept tail is delivered and a trailing partial line is held', async () => {
  const dir = makeRunDir();
  const log = join(dir, 'logs', 'rot4.jsonl');
  // Start at EOF of a large file, then rotate without the subscriber ever
  // having consumed a line (lastLine is empty → no marker → replay all).
  let body = '';
  for (let i = 0; i < 100; i++) body += seqLine(i);
  writeFileSync(log, body);
  const { sub, events, done } = await startTail(dir, 'rot4');
  try {
    await new Promise(r => setTimeout(r, 300));
    assert.equal(events.length, 0);
    assert.equal(rotateLogFileIfNeeded(log, { maxBytes: 10, keepLines: 5 }), true);
    // Append a partial line so the resume path must carry it over.
    const half = seqLine(500, 'error');
    appendFileSync(log, half.slice(0, 10));
    await waitFor(() => events.length >= 5);
    assert.deepEqual(events.map(e => e.seq), [95, 96, 97, 98, 99]);
    appendFileSync(log, half.slice(10));
    await waitFor(() => events.length >= 6);
    assert.equal(events[5].seq, 500);
    assert.equal(events[5].type, 'error');
  } finally {
    sub.stop();
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
});
