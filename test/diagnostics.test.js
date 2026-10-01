// Tests for the opt-in, local-only health diagnostics (#102): bounded
// counters on watch()/Subscriber and the --diagnostics stderr summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, emptyWatchStats } from '../dist/watch.js';
import { Subscriber } from '../dist/subscriber.js';
import { startDiagnostics } from '../dist/diagnostics.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

test('watch stats start at zero and count lines, emitted and filtered events', async () => {
  const input = new PassThrough();
  const events = [];
  const handle = watch({ session: 'dtest', cli: 'claude', input, filter: ['error'], onEvent: e => events.push(e) });
  assert.deepEqual(handle.stats(), emptyWatchStats());

  input.write('Error: something exploded\n');
  input.write('esc to interrupt\n'); // classifies as a non-error event → filtered
  input.write('\n');
  await settle();
  handle.stop();

  const s = handle.stats();
  assert.equal(s.linesSeen, 3);
  assert.equal(s.eventsEmitted, events.length);
  assert.ok(s.eventsEmitted >= 1);
  assert.ok(s.eventsFiltered >= 1, `expected a filtered event, got ${JSON.stringify(s)}`);
  assert.equal(s.classifyErrors, 0);
  assert.equal(s.inputErrors, 0);
  // Snapshot, not a live reference.
  s.linesSeen = 999;
  assert.equal(handle.stats().linesSeen, 3);
});

test('watch counts swallowed input errors and classification failures instead of hiding them', async () => {
  const input = new PassThrough();
  const handle = watch({
    session: 'dtest', cli: 'claude', input,
    onEvent: () => { throw new Error('consumer blew up'); },
  });
  input.write('Error: boom\n');
  input.emit('error', new Error('EIO'));
  await settle();
  handle.stop();
  const s = handle.stats();
  assert.equal(s.classifyErrors, 1, 'onEvent throwing is swallowed and counted');
  assert.ok(s.inputErrors >= 1, 'input error is swallowed and counted');
});

test('capture mode counts polls and failures when tmux is unavailable', async () => {
  const handle = watch({
    session: 'no-such-pluk-pane', cli: 'claude', mode: 'capture', captureIntervalMs: 10,
    onEvent: () => {},
  });
  await settle(80);
  handle.stop();
  const s = handle.stats();
  assert.ok(s.framesPolled >= 2, `expected polls, got ${JSON.stringify(s)}`);
  assert.equal(s.captureFailures, s.framesPolled, 'every poll against a missing pane is a counted failure');
  assert.equal(s.eventsEmitted, 0);
});

test('Subscriber stats count malformed and filtered lines', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pluk-diag-'));
  try {
    mkdirSync(join(runDir, 'logs'));
    const good = JSON.stringify({ type: 'error', ts: new Date().toISOString(), session: 's', source: 'watch', data: {} });
    const other = JSON.stringify({ type: 'state_change', ts: new Date().toISOString(), session: 's', source: 'watch', data: { to: 'idle' } });
    writeFileSync(join(runDir, 'logs', 's.jsonl'), `${good}\nnot json\n{"type":"x"}\n${other}\n\n`);
    const sub = new Subscriber({ session: 's', runDir, fromBeginning: true, filter: ['error'] });
    assert.deepEqual(sub.stats(), { linesRead: 0, malformedLines: 0, eventsFiltered: 0, eventsEmitted: 0 });
    const got = [];
    sub.on('event', e => got.push(e));
    const started = sub.start();
    await settle(400);
    sub.stop();
    await started;
    assert.equal(got.length, 1);
    assert.deepEqual(sub.stats(), { linesRead: 4, malformedLines: 2, eventsFiltered: 1, eventsEmitted: 1 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('startDiagnostics is a no-op without the flag', () => {
  const lines = [];
  const stop = startDiagnostics('watch', () => ({ a: 1 }), undefined, l => lines.push(l));
  stop();
  assert.deepEqual(lines, []);
});

test('startDiagnostics writes periodic and final JSON lines with fixed keys only', async () => {
  const lines = [];
  let n = 0;
  const stop = startDiagnostics('subscribe', () => ({ linesRead: ++n }), '0.02', l => lines.push(l));
  await settle(70);
  stop();
  stop(); // idempotent
  assert.ok(lines.length >= 2, `expected periodic + final, got ${lines.length}`);
  const parsed = lines.map(l => JSON.parse(l));
  for (const p of parsed) {
    assert.equal(p.pluk_diagnostics, 1);
    assert.equal(p.command, 'subscribe');
    assert.equal(typeof p.uptime_s, 'number');
    assert.deepEqual(Object.keys(p).sort(), ['command', 'final', 'linesRead', 'pluk_diagnostics', 'uptime_s']);
  }
  assert.equal(parsed.at(-1).final, true);
  assert.ok(parsed.slice(0, -1).every(p => p.final === false));
});

test('startDiagnostics falls back to the default period for a bad value and survives a throwing writer', async () => {
  const lines = [];
  const stop = startDiagnostics('watch', () => ({ x: 1 }), 'nope', l => { lines.push(l); throw new Error('stderr gone'); });
  await settle(30);
  stop();
  assert.equal(lines.length, 1, 'bad period means no periodic line within 30ms, only the final one');
});

test('pluk watch --diagnostics prints a final summary on stderr and keeps stdout pure JSONL', () => {
  const res = spawnSync(process.execPath, [CLI, 'watch', 'diag-cli', '--cli=claude', '--diagnostics'], {
    encoding: 'utf-8', timeout: 30000, input: 'Error: one\nplain line\n',
  });
  assert.equal(res.status, 0, res.stderr);
  const events = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.every(e => typeof e.type === 'string'), 'stdout carries only events');
  const diag = res.stderr.trim().split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.equal(diag.length, 1, `expected one final summary, stderr: ${res.stderr}`);
  assert.equal(diag[0].command, 'watch');
  assert.equal(diag[0].final, true);
  assert.equal(diag[0].linesSeen, 2);
  assert.equal(diag[0].eventsEmitted, events.length);
  assert.ok(!('session' in diag[0]), 'summary never names the session');
  assert.ok(!res.stderr.includes('diag-cli'), 'summary never includes the session name');
});
