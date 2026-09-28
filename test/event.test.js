// Tests for src/event.ts — event creation and JSONL parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, parseEvent } from '../dist/event.js';

test('createEvent populates envelope fields', () => {
  const e = createEvent('sess1', '%3', 'watch', 7, 'state_change', { from: 'idle', to: 'working' });
  assert.equal(e.v, 1);
  assert.equal(e.session, 'sess1');
  assert.equal(e.pane, '%3');
  assert.equal(e.source, 'watch');
  assert.equal(e.seq, 7);
  assert.equal(e.type, 'state_change');
  assert.deepEqual(e.data, { from: 'idle', to: 'working' });
  assert.equal(e.pid, process.pid);
});

test('createEvent timestamp is ISO-8601 truncated to milliseconds', () => {
  const e = createEvent('s', 'p', 'src', 0, 'error', {});
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const parsed = new Date(e.ts).getTime();
  assert.ok(Math.abs(Date.now() - parsed) < 5000);
});

test('parseEvent round-trips a created event', () => {
  const e = createEvent('s', 'p', 'src', 1, 'rate_limit', { detail: 'quota' });
  const back = parseEvent(JSON.stringify(e));
  assert.deepEqual(back, e);
});

test('parseEvent returns null on malformed JSON', () => {
  assert.equal(parseEvent('not json'), null);
  assert.equal(parseEvent('{"truncated":'), null);
  assert.equal(parseEvent(''), null);
});

test('parseEvent rejects valid JSON that is not an event object', () => {
  assert.equal(parseEvent('123'), null);
  assert.equal(parseEvent('"a string"'), null);
  assert.equal(parseEvent('null'), null);
  assert.equal(parseEvent('[1,2,3]'), null);
});

test('parseEvent rejects objects missing type, ts, or data', () => {
  assert.equal(parseEvent('{"type":"error"}'), null);
  assert.equal(parseEvent('{"ts":"2026-01-01T00:00:00.000Z","data":{}}'), null);
  assert.equal(parseEvent('{"type":"error","ts":"2026-01-01T00:00:00.000Z"}'), null);
  assert.equal(parseEvent('{"type":"error","ts":"2026-01-01T00:00:00.000Z","data":null}'), null);
  assert.equal(parseEvent('{"type":"error","ts":"2026-01-01T00:00:00.000Z","data":[1]}'), null);
});

test('parseEvent rejects non-string data values', () => {
  assert.equal(parseEvent('{"type":"error","ts":"2026-01-01T00:00:00.000Z","data":{"n":5}}'), null);
});

test('parseEvent accepts a minimal well-formed event', () => {
  const e = parseEvent('{"type":"error","ts":"2026-01-01T00:00:00.000Z","data":{"message":"boom"}}');
  assert.ok(e);
  assert.equal(e.type, 'error');
  assert.equal(e.data['message'], 'boom');
});
