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
    // A well-formed event line: only the .jsonl extension filter can exclude this file.
    writeFileSync(join(dir, 'logs', 'noise.txt'), eventLine({ ts: '2026-01-01T00:00:00.000Z' }) + '\n');
    writeFileSync(join(dir, 'logs', 'rotated.jsonl.1'), eventLine({ ts: '2026-01-01T00:00:00.000Z' }) + '\n');
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
    // malformed line is not an event and is excluded from eventCount
    assert.equal(sessions[0].eventCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions keeps the last real cli when a later event reports cli:"unknown"', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'tool_call', data: { tool: 'bash', cli: 'copilot' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'tool_call', data: { tool: 'bash', cli: 'unknown' } }),
    ];
    writeFileSync(join(dir, 'logs', 'agent3.jsonl'), lines.join('\n') + '\n');

    assert.equal(discoverSessions(dir)[0].cli, 'copilot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions does not treat cli:"unknown" inside the tail window as the cli marker', () => {
  const dir = makeRunDir();
  try {
    // The real cli sits past the 50-event window, on an event that is not the
    // state_change. If cli:"unknown" counted as "cli seen", the scan would stop
    // at the state_change and report unknown.
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'rate_limit', data: { cli: 'claude' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { to: 'working' } }),
    ];
    for (let i = 0; i < 60; i++) {
      lines.push(eventLine({ ts: `2026-01-01T00:10:${String(i % 60).padStart(2, '0')}.000Z`, type: 'tool_call', data: { tool: 'bash', cli: 'unknown' } }));
    }
    writeFileSync(join(dir, 'logs', 'unknown-flood.jsonl'), lines.join('\n') + '\n');

    const s = discoverSessions(dir)[0];
    assert.equal(s.cli, 'claude');
    assert.equal(s.state, 'working');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions reports state "unknown" for a state_change without a "to" field', () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, 'logs', 'agent4.jsonl'),
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { from: 'idle' } }) + '\n');

    assert.equal(discoverSessions(dir)[0].state, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions takes lastActivity from the newest ts, not the last line, when lines are out of order', () => {
  const dir = makeRunDir();
  try {
    // tool_call rather than raw_output: only the newest raw_output line is retained.
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:05.000Z', type: 'tool_call', data: { tool: 'bash' } }),
      eventLine({ ts: '2026-01-01T00:00:09.000Z', type: 'tool_call', data: { tool: 'bash' } }),
      eventLine({ ts: '2026-01-01T00:00:02.000Z', type: 'tool_call', data: { tool: 'bash' } }),
    ];
    writeFileSync(join(dir, 'logs', 'skewed.jsonl'), lines.join('\n') + '\n');

    assert.equal(discoverSessions(dir)[0].lastActivity, '2026-01-01T00:00:09.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions sorts sessions by most recent activity first', () => {
  const dir = makeRunDir();
  try {
    // Named so that directory order (a-, b-, c-) is the reverse of activity order:
    // readdirSync already yields 'newer' before 'older', which would pass without the sort.
    writeFileSync(join(dir, 'logs', 'a-oldest.jsonl'),
      eventLine({ ts: '2026-01-01T00:00:00.000Z' }) + '\n');
    writeFileSync(join(dir, 'logs', 'b-middle.jsonl'),
      eventLine({ ts: '2026-03-01T00:00:00.000Z' }) + '\n');
    writeFileSync(join(dir, 'logs', 'c-newest.jsonl'),
      eventLine({ ts: '2026-06-01T00:00:00.000Z' }) + '\n');

    const names = discoverSessions(dir).map(s => s.session);
    assert.deepEqual(names, ['c-newest', 'b-middle', 'a-oldest']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions keeps state and cli when more than 50 events follow the last state_change', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'working', cli: 'claude' } }),
    ];
    for (let i = 0; i < 60; i++) {
      lines.push(eventLine({ ts: `2026-01-01T00:10:${String(i % 60).padStart(2, '0')}.000Z`, type: 'rate_limit' }));
    }
    writeFileSync(join(dir, 'logs', 'long.jsonl'), lines.join('\n') + '\n');

    const s = discoverSessions(dir)[0];
    assert.equal(s.state, 'working');
    assert.equal(s.cli, 'claude');
    assert.equal(s.eventCount, 61);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions keeps state and cli when raw_output floods after the last state_change', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'working', cli: 'claude' } }),
    ];
    for (let i = 0; i < 500; i++) {
      lines.push(eventLine({ ts: `2026-01-01T00:10:${String(i % 60).padStart(2, '0')}.000Z`, data: { line: `out ${i}` } }));
    }
    writeFileSync(join(dir, 'logs', 'noisy.jsonl'), lines.join('\n') + '\n');

    const s = discoverSessions(dir)[0];
    assert.equal(s.state, 'working');
    assert.equal(s.cli, 'claude');
    assert.equal(s.eventCount, 501);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions stays fast on a rotation-sized log with no state_change (scan past the window must not be quadratic)', () => {
  const dir = makeRunDir();
  try {
    // A PLUK_LOG_MAX_BYTES-sized log of tool events and no state_change: the marker scan
    // walks the whole file. Collecting every event on the way made this take seconds.
    const line = eventLine({ ts: '2026-01-01T00:10:00.000Z', type: 'tool_call', data: { tool: 'bash' } }) + '\n';
    const chunk = line.repeat(1000);
    let content = '';
    while (content.length < 16 * 1024 * 1024) content += chunk;
    writeFileSync(join(dir, 'logs', 'flood.jsonl'), content);

    const started = Date.now();
    const s = discoverSessions(dir)[0];
    const elapsed = Date.now() - started;
    assert.equal(s.state, 'unknown');
    assert.equal(s.cli, 'unknown');
    assert.equal(s.lastActivity, '2026-01-01T00:10:00.000Z');
    assert.ok(elapsed < 2000, `discoverSessions took ${elapsed}ms on a 16 MB log without state_change`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions keeps only the newest state_change and cli found past the tail window', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'idle', cli: 'codex' } }),
      eventLine({ ts: '2026-01-01T00:00:01.000Z', type: 'state_change', data: { to: 'working' } }),
      eventLine({ ts: '2026-01-01T00:00:02.000Z', type: 'rate_limit', data: { cli: 'claude' } }),
    ];
    for (let i = 0; i < 200; i++) {
      lines.push(eventLine({ ts: `2026-01-01T00:10:${String(i % 60).padStart(2, '0')}.000Z`, type: 'tool_call', data: { tool: 'bash' } }));
    }
    writeFileSync(join(dir, 'logs', 'busy.jsonl'), lines.join('\n') + '\n');

    const s = discoverSessions(dir)[0];
    assert.equal(s.state, 'working');
    assert.equal(s.cli, 'claude');
    assert.equal(s.eventCount, 203);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions strips terminal control characters from log-sourced fields', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({
        ts: '2026-01-01T00:00:00.000Z',
        type: 'rate_limit',
        data: { cli: '\u001b]0;PWNED\u0007claude' },
      }),
      eventLine({
        ts: '2026-01-01T00:00:01.000Z',
        type: 'state_change',
        data: { to: '\u001b[2J\u001b[Hidle' },
      }),
    ];
    writeFileSync(join(dir, 'logs', 'evil.jsonl'), lines.join('\n') + '\n');

    const s = discoverSessions(dir)[0];
    assert.equal(s.cli, ']0;PWNEDclaude');
    assert.equal(s.state, '[2J[Hidle');
    assert.doesNotMatch(s.cli, /[\u0000-\u001f\u007f-\u009f]/);
    assert.doesNotMatch(s.state, /[\u0000-\u001f\u007f-\u009f]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions strips control characters from session names (log filenames)', () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, 'logs', 'agent\u001b[31m.jsonl'),
      eventLine({ ts: '2026-01-01T00:00:00.000Z' }) + '\n');

    const s = discoverSessions(dir)[0];
    assert.equal(s.session, 'agent[31m');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeField removes C0, DEL, and C1 control characters', async () => {
  const { sanitizeField } = await import('../dist/sessions.js');
  assert.equal(sanitizeField('a\u0000b\u001fc\u007fd\u0080e\u009ff'), 'abcdef');
  assert.equal(sanitizeField('plain-name_1.2'), 'plain-name_1.2');
});

test('discoverSessions picks up cli from a state_change event (#197)', () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, 'logs', 'agent1.jsonl'), eventLine({
      ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { from: 'unknown', to: 'working', cli: 'goose' },
    }) + '\n');
    assert.equal(discoverSessions(dir)[0].cli, 'goose');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverSessions ignores events whose ts is not a valid date (#270)', () => {
  const dir = makeRunDir();
  try {
    const lines = [
      eventLine({ ts: '2026-01-01T00:00:00.000Z', type: 'state_change', data: { to: 'idle' } }),
      eventLine({ ts: 'zzz', type: 'raw_output' }),
    ];
    writeFileSync(join(dir, 'logs', 'a.jsonl'), lines.join('\n') + '\n');
    writeFileSync(join(dir, 'logs', 'b.jsonl'), eventLine({ ts: 'zzz' }) + '\n');

    const byName = Object.fromEntries(discoverSessions(dir).map(s => [s.session, s]));
    assert.equal(byName.a.lastActivity, '2026-01-01T00:00:00.000Z');
    assert.match(byName.a.lastActivityAgo, /^\d+d ago$/);
    assert.equal(byName.b.lastActivity, '');
    assert.equal(byName.b.lastActivityAgo, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
