import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync, truncateSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Subscriber } from '../dist/subscriber.js';

const seqLine = seq => JSON.stringify({ v: 1, ts: '2026-01-01T00:00:00.000Z', seq, pid: 1, session: 's', pane: 'p', source: 't', type: 'raw_output', data: {} }) + '\n';
const waitFor = (p, ms = 3000) => new Promise((res, rej) => { const d = Date.now() + ms; const t = setInterval(() => { if (p()) { clearInterval(t); res(); } else if (Date.now() > d) { clearInterval(t); rej(new Error('timeout')); } }, 20); });

test('rotation landing right after the first chunk is read from an empty log is still detected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-rot-'));
  mkdirSync(join(dir, 'logs'));
  const log = join(dir, 'logs', 's.jsonl');
  writeFileSync(log, '');
  const logged = [];
  const orig = console.error;
  console.error = m => logged.push(String(m));
  const sub = new Subscriber({ session: 's', runDir: dir, verbose: true });
  const events = [];
  const sent = Array.from({ length: 120 }, (_, i) => seqLine(i));
  sub.on('event', e => {
    events.push(e);
    if (e.seq === 99) {
      // Rotate while the subscriber is still inside its first consume loop:
      // 100..119 appended, kept tail 20..119 written over offset 0, truncated.
      appendFileSync(log, sent.slice(100).join(''));
      const tail = Buffer.from(sent.slice(20).join(''));
      const fd = openSync(log, 'r+'); writeSync(fd, tail, 0, tail.length, 0); closeSync(fd);
      truncateSync(log, tail.length);
    }
  });
  const done = sub.start();
  try {
    await new Promise(r => setTimeout(r, 300));
    appendFileSync(log, sent.slice(0, 100).join(''));
    await waitFor(() => events.length >= 120).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    assert.ok(logged.some(m => m.includes('resuming after rotation')), 'rotation must be detected');
    assert.equal(sub.stats().malformedLines, 0);
    assert.deepEqual(events.map(e => e.seq), sent.map((_, i) => i), 'each of 0..119 exactly once, in order');
  } finally {
    console.error = orig; sub.stop(); await done; rmSync(dir, { recursive: true, force: true });
  }
});
