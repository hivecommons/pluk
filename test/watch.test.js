// Tests for src/watch.ts — stream-mode classification of piped terminal output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from '../dist/watch.js';

function collect(opts = {}) {
  const input = new PassThrough();
  const events = [];
  const handle = watch({
    session: 'wtest',
    cli: 'claude',
    input,
    onEvent: e => events.push(e),
    ...opts,
  });
  return { input, events, handle };
}

function settle(ms = 50) {
  return new Promise(r => setTimeout(r, ms));
}

test('stream mode emits events for classified lines', async () => {
  const { input, events, handle } = collect();
  input.write('Error: something exploded\n');
  await settle();
  handle.stop();

  assert.ok(events.length >= 1, 'expected at least one event');
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].session, 'wtest');
  assert.equal(events[0].source, 'watch');
});

test('ANSI escape codes are stripped before classification', async () => {
  const { input, events, handle } = collect();
  input.write('\x1b[31mError:\x1b[0m red alert\n');
  await settle();
  handle.stop();

  assert.equal(events[0].type, 'error');
});

test('filter suppresses non-matching classified events', async () => {
  const { input, events, handle } = collect({ filter: ['rate_limit'] });
  input.write('Error: dropped by filter\n');
  input.write('Claude usage limit reached\n');
  await settle();
  handle.stop();

  assert.deepEqual(events.map(e => e.type), ['rate_limit']);
});

test('includeRaw emits raw_output events alongside classified ones', async () => {
  const { input, events, handle } = collect({ includeRaw: true });
  input.write('plain unclassified chatter\n');
  await settle();
  handle.stop();

  const raw = events.filter(e => e.type === 'raw_output');
  assert.equal(raw.length, 1);
  assert.equal(raw[0].data['line'], 'plain unclassified chatter');
});

test('includeRaw respects the filter for raw_output', async () => {
  const { input, events, handle } = collect({ includeRaw: true, filter: ['error'] });
  input.write('plain chatter\n');
  input.write('Error: kept\n');
  await settle();
  handle.stop();

  assert.deepEqual(events.map(e => e.type), ['error']);
});

test('blank/whitespace-only lines never emit events', async () => {
  const { input, events, handle } = collect({ includeRaw: true });
  input.write('\n');
  input.write('   \n');
  await settle();
  handle.stop();

  assert.equal(events.length, 0);
});

test('input stream errors do not crash the watcher', async () => {
  const { input, events, handle } = collect();
  input.emit('error', new Error('pipe broke'));
  input.write('Error: still classified\n');
  await settle();
  handle.stop();

  assert.equal(events[0].type, 'error');
});

test('stop() ends line processing', async () => {
  const { input, events, handle } = collect();
  handle.stop();
  input.write('Error: after stop\n');
  await settle();

  assert.equal(events.length, 0);
});

test('a custom patternsDir drives classification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-watch-'));
  try {
    writeFileSync(join(dir, 'mycli.patterns'), "ERROR_PATTERN='^KABOOM'\n");
    const { input, events, handle } = collect({ cli: 'mycli', patternsDir: dir });
    input.write('KABOOM at line 3\n');
    await settle();
    handle.stop();

    assert.equal(events[0].type, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture mode returns a stop handle and never throws without tmux', async () => {
  const events = [];
  const handle = watch({
    session: 'no-such-tmux-session',
    cli: 'claude',
    mode: 'capture',
    captureIntervalMs: 20,
    onEvent: e => events.push(e),
  });
  await settle(80);
  handle.stop();
  // No pane exists, so polling must stay silent rather than crash.
  assert.deepEqual(events, []);
});
