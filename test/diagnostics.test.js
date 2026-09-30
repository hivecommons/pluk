// Tests for src/diagnostics.ts — bounded health counters and stderr reporter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWatchDiagnostics,
  createSubscriberDiagnostics,
  startDiagnosticsReporter,
} from '../dist/diagnostics.js';

test('createWatchDiagnostics returns a fixed set of zeroed counters', () => {
  const d = createWatchDiagnostics();
  assert.deepEqual(d, {
    eventsEmitted: 0,
    capturePolls: 0,
    captureFailures: 0,
    linesProcessed: 0,
    lineErrors: 0,
    streamErrors: 0,
  });
});

test('createSubscriberDiagnostics returns a fixed set of zeroed counters', () => {
  const d = createSubscriberDiagnostics();
  assert.deepEqual(d, { eventsEmitted: 0, malformedSkipped: 0 });
});

test('startDiagnosticsReporter writes a bounded JSON summary on each tick', async () => {
  const lines = [];
  const counters = { eventsEmitted: 2 };
  const reporter = startDiagnosticsReporter('watch', () => counters, 10, line => lines.push(line));

  await new Promise(resolve => setTimeout(resolve, 35));
  reporter.stop();

  assert.ok(lines.length >= 1, 'expected at least one diagnostics line');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.diagnostics, 'watch');
  assert.equal(parsed.eventsEmitted, 2);
  assert.equal(typeof parsed.ts, 'string');
});

test('startDiagnosticsReporter reflects live counter updates across ticks', async () => {
  const lines = [];
  const counters = { eventsEmitted: 0 };
  const reporter = startDiagnosticsReporter('subscribe', () => counters, 10, line => lines.push(line));

  await new Promise(resolve => setTimeout(resolve, 15));
  counters.eventsEmitted = 5;
  await new Promise(resolve => setTimeout(resolve, 20));
  reporter.stop();

  const values = lines.map(l => JSON.parse(l).eventsEmitted);
  assert.ok(values.includes(5), `expected a later tick to report 5, got ${JSON.stringify(values)}`);
});

test('startDiagnosticsReporter.stop() flushes a final summary', () => {
  const lines = [];
  const counters = { eventsEmitted: 9 };
  const reporter = startDiagnosticsReporter('watch', () => counters, 100_000, line => lines.push(line));
  reporter.stop();

  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).eventsEmitted, 9);
});
