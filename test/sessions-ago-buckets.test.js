// Pins the relative-time buckets behind SessionInfo.lastActivityAgo, the
// "LAST ACTIVITY" column of `pluk sessions`. Every other sessions fixture
// uses a fixed 2026-01-01 timestamp, so only the `Nd ago` arm ever ran; the
// just-now / seconds / minutes / hours arms are exercised here with
// timestamps derived from Date.now().
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessions } from '../dist/sessions.js';

function makeRunDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-ago-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function eventLine(ts) {
  return JSON.stringify({
    v: 1, ts, seq: 0, pid: 1, session: 's', pane: 'p', source: 't', type: 'raw_output', data: {},
  }) + '\n';
}

function agoFor(offsetMs) {
  const dir = makeRunDir();
  try {
    const ts = new Date(Date.now() - offsetMs).toISOString();
    writeFileSync(join(dir, 'logs', 'a.jsonl'), eventLine(ts));
    const [s] = discoverSessions(dir);
    assert.equal(s.lastActivity, ts);
    return s.lastActivityAgo;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('lastActivityAgo reports "just now" for a timestamp in the future', () => {
  // A clock skewed ahead of the writer must not render a negative age.
  assert.equal(agoFor(-60_000), 'just now');
});

test('lastActivityAgo uses seconds under one minute', () => {
  assert.match(agoFor(20_000), /^(1\d|2\d)s ago$/);
});

test('lastActivityAgo uses minutes under one hour', () => {
  assert.match(agoFor(5 * 60_000), /^[45]m ago$/);
});

test('lastActivityAgo uses hours under one day', () => {
  assert.match(agoFor(3 * 3_600_000), /^[23]h ago$/);
});

test('lastActivityAgo uses days from one day onward', () => {
  assert.match(agoFor(2 * 86_400_000), /^[12]d ago$/);
});
