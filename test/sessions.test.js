// Tests for src/sessions.ts — session discovery from JSONL run-dir logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessions } from '../dist/sessions.js';

function makeRunDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-run-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function eventLine({ ts, type = 'raw_output', data = {} }) {
  return JSON.stringify({
    v: 1, ts, seq: 0, pid: 1, session: 's', pane: 'p', source: 't', type, data,
  });
}

test('discoverSessions returns [] when the logs dir does not exist', () => {
  assert.deepEqual(discoverSessions('/nonexistent/pluk-run-dir'), []);
});

test('discoverSessions skips empty and non-jsonl files', () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, 'logs', 'empty.jsonl'), '');
    writeFileSync(join(dir, 'logs', 'noise.txt'), 'not a log\n');
    assert.deepEqual(discoverSessions(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions extracts cli, state, last activity, and event count', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'raw_output', data: { cli: 'claude' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { from: 'idle', to: 'working' } }),
      eventLine({ ts: '2026-01-01T00:00:02.000Z', type: 'state_change', data: { from: 'working', to: 'idle' } }),
    ];
    writeFileSync(join(dir, 'logs', 'agent1.jsonl'), lines.join('\n') + '\n');

    const sessions = discoverSessions(dir);
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.session, 'agent1');
    assert.equal(s.cli, 'claude');
    assert.equal(s.state, 'idle');
    assert.equal(s.lastActivity, '2026-01-01T00:00:02.000Z');
    assert.equal(s.eventCount, 3);
    assert.equal(s.logFile, join(dir, 'logs', 'agent1.jsonl'));
    assert.match(s.lastActivityAgo, /ago$/);
    assert.equal(typeof s.tmuxAlive, 'boolean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions ignores cli:"unknown" markers and tolerates malformed lines', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      'this is not json',
      eventLine({ ts: '2026-01-01T00:00:00.000Z', data: { cli: 'unknown' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', data: { cli: 'copilot' } }),
    ];
    writeFileSync(join(dir, 'logs', 'agent2.jsonl'), lines.join('\n') + '\n');

    const sessions = discoverSessions(dir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].cli, 'copilot');
    // malformed line still counts as a raw line for eventCount
    assert.equal(sessions[0].eventCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions sorts sessions by most recent activity first', () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, 'logs', 'older.jsonl'),
      eventLine({ ts: '2026-01-01T00:00:00.000Z' }) + '\n');
    writeFileSync(join(dir, 'logs', 'newer.jsonl'),
      eventLine({ ts: '2026-06-01T00:00:00.000Z' }) + '\n');

    const names = discoverSessions(dir).map(s => s.session);
    assert.deepEqual(names, ['newer', 'older']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions only inspects the last 100 lines for state', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'working', cli: 'claude' } }),
    ];
    for (let i = 0; i < 150; i++) {
      lines.push(eventLine({ ts: `2026-01-01T00:10:${String(i % 60).padStart(2, '0')}.000Z` }));
    }
    writeFileSync(join(dir, 'logs', 'long.jsonl'), lines.join('\n') + '\n');

    const s = discoverSessions(dir)[0];
    // early state_change and cli marker fell outside the 100-line tail window
    assert.equal(s.state, 'unknown');
    assert.equal(s.cli, 'unknown');
    assert.equal(s.eventCount, 151);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
