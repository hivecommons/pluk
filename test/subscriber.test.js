// Tests for src/subscriber.ts — JSONL log tailing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subscriber, subscribe } from '../dist/subscriber.js';

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
