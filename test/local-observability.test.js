import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Classifier } from '../dist/classifier.js';
import { parsePatternsContent, PATTERN_KEYS } from '../dist/patterns.js';
import { log } from '../dist/diagnostics.js';
import { watch } from '../dist/watch.js';
import { writeLocalStats } from '../dist/local-stats.js';
import { buildPipePaneCommand } from '../dist/attach.js';
import { tmuxRunInherited, tmuxSendKeys } from '../dist/tmux.js';
import { Subscriber } from '../dist/subscriber.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const FAST_TIMERS = join(process.cwd(), 'test', 'fixtures', 'fast-timers.mjs');
const parseLines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const patterns = parsePatternsContent("IDLE_PATTERN='^idle$'\nWORKING_PATTERNS='^working$'\nERROR_PATTERN='^error$'\nTRUST_DIALOG_PATTERN='^blocked$'\n", 'private-cli');

function withEnv(t, entries) {
  const previous = Object.fromEntries(Object.keys(entries).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-local-observability-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('log JSON escapes multiline messages and has the same schema for every level/prefix', t => {
  withEnv(t, { PLUK_LOG_FORMAT: 'json', NO_COLOR: undefined });
  const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  process.stderr.isTTY = true;
  t.after(() => {
    if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
    else delete process.stderr.isTTY;
  });
  const output = t.mock.method(console, 'error', () => {});
  for (const level of ['info', 'warn', 'error']) log(level, 'hello\n"world"\x1b', '[custom]');
  assert.deepEqual(output.mock.calls.map(call => JSON.parse(call.arguments[0])),
    ['info', 'warn', 'error'].map(level => ({ level, message: 'hello\n"world"\x1b' })));
  assert.ok(output.mock.calls.every(call => !call.arguments[0].includes('\x1b')));
});

test('unknown log formats retain the existing human prefixes', t => {
  withEnv(t, { PLUK_LOG_FORMAT: 'unsupported', NO_COLOR: '1' });
  const output = t.mock.method(console, 'error', () => {});
  log('warn', 'careful');
  log('info', 'bare', '');
  log('info', 'verbose', '[pluk:sub]');
  assert.deepEqual(output.mock.calls.map(call => call.arguments[0]), ['Warning: careful', 'bare', '[pluk:sub] verbose']);
});

for (const args of [
  ['bogus-command'],
  ['send'],
  ['watch', 's', '--unexpected'],
  ['watch', 's', '--capture=0'],
  ['watch', 's', '--filter=bad'],
  ['watch', 's', '--include-raw=bad'],
  ['watch', 's', '--pane='],
  ['watch', 's', '--pane'],
]) {
  test(`CLI JSON diagnostics cover ${args.join(' ')}`, () => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', env: { ...process.env, PLUK_LOG_FORMAT: 'json' },
    });
    assert.notEqual(result.status, 0);
    const lines = parseLines(result.stderr);
    assert.ok(lines.length > 0);
    assert.equal(lines[0].level, 'error');
    assert.ok(lines.every(line => Object.keys(line).sort().join(',') === 'level,message'));
    if (args[0] === 'bogus-command') assert.match(lines[0].message, /Unknown command: bogus-command/);
  });
}

test('CLI JSON warnings preserve stdout events and structured health summaries', t => {
  const dir = scratch(t);
  const result = spawnSync(process.execPath, [CLI, 'watch', 'secret-session', '--pane=%1', '--diagnostics', `--run-dir=${dir}`], {
    encoding: 'utf8', input: 'Error: visible event\n', env: { ...process.env, PLUK_LOG_FORMAT: 'json' }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(parseLines(result.stdout).some(event => event.type === 'error'));
  const diagnostics = parseLines(result.stderr);
  assert.ok(diagnostics.some(line => line.level === 'warn' && line.message === '--pane is ignored without --capture'));
  assert.ok(diagnostics.some(line => line.pluk_diagnostics === 1 && line.final === true));
  const snapshot = JSON.parse(readFileSync(join(dir, 'stats', 'watch.json'), 'utf8'));
  assert.equal(snapshot.linesSeen, 1);
  assert.equal(snapshot.patternMatches.ERROR_PATTERN, 1);
  assert.equal(snapshot.classifierMisses, 0);
  assert.ok(!JSON.stringify(snapshot).includes('secret-session'));
  assert.deepEqual(readdirSync(join(dir, 'stats')), ['watch.json']);
});

test('Subscriber verbose diagnostics use JSON through the shared helper', async t => {
  withEnv(t, { PLUK_LOG_FORMAT: 'json' });
  const dir = scratch(t);
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 's.jsonl'), '');
  const output = t.mock.method(console, 'error', () => {});
  const sub = new Subscriber({ session: 's', runDir: dir, verbose: true });
  const started = sub.start();
  sub.stop();
  await started;
  assert.ok(output.mock.callCount() > 0);
  assert.ok(output.mock.calls.every(call => JSON.parse(call.arguments[0]).level === 'info'));
});

test('detector observations distinguish misses from repeated, suppressed and debounced state evidence', () => {
  const observations = [];
  let now = 100;
  const classifier = new Classifier({ session: 's', patterns, clock: () => now, onPattern: id => observations.push(id) });
  assert.equal(classifier.classify('working').type, 'state_change');
  assert.equal(classifier.classify('working'), null);
  assert.equal(classifier.classify('idle'), null, 'idle is suppressed by fresh working evidence');
  now++;
  assert.equal(classifier.classify('working'), null, 'still working');
  assert.equal(classifier.classify('unmatched'), null);
  assert.equal(classifier.classify(''), null);
  assert.equal(classifier.classify('error').type, 'error');
  assert.deepEqual(observations, ['WORKING_PATTERNS', 'WORKING_PATTERNS', 'IDLE_PATTERN', 'WORKING_PATTERNS', null, 'ERROR_PATTERN']);
  observations.length = 0;
  const debounced = new Classifier({ session: 's', patterns, clock: () => now, onPattern: id => observations.push(id) });
  debounced.classify('idle');
  now++;
  assert.equal(debounced.classify('working'), null, 'a new state inside the debounce window is deferred');
  assert.deepEqual(observations, ['IDLE_PATTERN', 'WORKING_PATTERNS']);
});

test('capture detector observations count state/modal evidence without treating a null verdict as a miss', () => {
  const observations = [];
  const classifier = new Classifier({ session: 's', patterns, clock: () => 100, onPattern: id => observations.push(id) });
  classifier.classifyFrame(['working', '', 'plain']);
  assert.equal(classifier.classifyFrame('working'), null, 'same state');
  assert.equal(classifier.classifyFrame('blocked\nidle'), null, 'blocked modal outranks idle');
  assert.deepEqual(observations, ['WORKING_PATTERNS', null, 'WORKING_PATTERNS', 'TRUST_DIALOG_PATTERN', 'IDLE_PATTERN']);
});

test('watch classification counters have only fixed ids and return deep snapshots before event filtering', async t => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'private-cli.patterns'), "IDLE_PATTERN='^idle$'\nERROR_PATTERN='^error$'\n");
  const input = new PassThrough();
  const handle = watch({ session: 'private-session', cli: 'private-cli', patternsDir: dir, input, filter: ['rate_limit'], onEvent: () => {} });
  t.after(() => handle.stop());
  input.write('idle\nidle\nerror\nplain\n\n');
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = handle.classificationStats();
  assert.deepEqual(Object.keys(snapshot.patternMatches).sort(), Object.keys(PATTERN_KEYS).sort());
  assert.equal(snapshot.patternMatches.IDLE_PATTERN, 2);
  assert.equal(snapshot.patternMatches.ERROR_PATTERN, 1);
  assert.equal(snapshot.classifierMisses, 1);
  assert.equal(handle.stats().eventsEmitted, 0);
  snapshot.patternMatches.IDLE_PATTERN = 999;
  snapshot.classifierMisses = 999;
  assert.equal(handle.classificationStats().patternMatches.IDLE_PATTERN, 2);
  assert.equal(handle.classificationStats().classifierMisses, 1);
  assert.ok(!JSON.stringify(snapshot).includes('private-'));
});

test('local snapshots atomically replace destination symlinks and use private fixed filenames', t => {
  const dir = scratch(t);
  writeLocalStats('watch', { classifierMisses: 1 }, dir);
  const file = join(dir, 'stats', 'watch.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'stats')).mode & 0o777, 0o700);
  const victim = join(dir, 'victim');
  writeFileSync(victim, 'untouched');
  rmSync(file);
  symlinkSync(victim, file);
  writeLocalStats('watch', { classifierMisses: 2 }, dir);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snapshot.pluk_stats, 1);
  assert.equal(snapshot.command, 'watch');
  assert.equal(snapshot.pid, process.pid);
  assert.equal(snapshot.classifierMisses, 2);
  assert.ok(Number.isFinite(Date.parse(snapshot.updated_at)));
  assert.deepEqual(readdirSync(join(dir, 'stats')), ['watch.json']);
});

test('snapshot failures are silent, preserve existing data and clean staging files', t => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'stats'));
  mkdirSync(join(dir, 'stats', 'watch.json')); // rename fails, without relying on root permissions
  assert.doesNotThrow(() => writeLocalStats('watch', { linesSeen: 1 }, dir));
  assert.deepEqual(readdirSync(join(dir, 'stats')), ['watch.json']);
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'original');
  assert.doesNotThrow(() => writeLocalStats('send', { tmuxSendFailures: 1 }, blocked));
  assert.equal(readFileSync(blocked, 'utf8'), 'original');
  const unsafe = join(dir, 'unsafe');
  symlinkSync(dir, unsafe);
  writeLocalStats('send', { tmuxSendFailures: 1 }, unsafe);
  assert.ok(!readdirSync(join(dir, 'stats')).includes('send.json'));
});

for (const status of [0, 1]) {
  test(`tmux send ${status ? 'failure' : 'success'} publishes a process snapshot without session/text labels`, t => {
    const dir = scratch(t);
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [CLI, 'send', 'private-target', '--text=private-message', '--enter'], {
      encoding: 'utf8', env: { ...process.env, PATH: dir, PLUK_RUN_DIR: dir, PLUK_LOG_FORMAT: 'json' },
    });
    assert.equal(result.status, status, result.stderr);
    const text = readFileSync(join(dir, 'stats', 'send.json'), 'utf8');
    const snapshot = JSON.parse(text);
    assert.equal(snapshot.tmuxSendFailures, status);
    assert.ok(!text.includes('private-target'));
    assert.ok(!text.includes('private-message'));
    assert.ok(!text.includes(dir));
    assert.deepEqual(readdirSync(join(dir, 'stats')), ['send.json']);
  });
}

test('active watchers publish initial, periodic and final snapshots without a diagnostics flag', async t => {
  const dir = scratch(t);
  const child = spawn(process.execPath, ['--import', FAST_TIMERS, CLI, 'watch', 's', `--run-dir=${dir}`], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PLUK_TEST_TIMER_CLAMP_MS: '20' },
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const file = join(dir, 'stats', 'watch.json');
  async function waitFor(predicate) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if (predicate()) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('watch snapshot was not published');
  }
  await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).linesSeen === 0);
  child.stdin.write('Error: counted before EOF\nplain\n');
  await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).linesSeen === 2);
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGINT');
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).classifierMisses, 1);
  assert.equal(stderr, '');
  assert.equal(parseLines(stdout)[0].type, 'error');
});

test('attach forwards the JSON log preference into the watcher shell command', () => {
  const command = buildPipePaneCommand({ runDir: '/private/run', plukBin: 'pluk', session: 's', cli: 'claude',
    includeRaw: false, logFile: '/private/run/logs/s.jsonl', env: { PLUK_LOG_FORMAT: 'json' } });
  assert.match(command, /PLUK_LOG_FORMAT='json'/);
});

test('shared tmux seam counts inherited send failures and preserves errors even if snapshots cannot be written', t => {
  const dir = scratch(t);
  withEnv(t, { PATH: dir, PLUK_RUN_DIR: dir });
  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.throws(() => tmuxRunInherited(['send-keys', '-t', '=s:', 'Enter'], dir));
  assert.equal(JSON.parse(readFileSync(join(dir, 'stats', 'send.json'), 'utf8')).tmuxSendFailures, 1);
  assert.throws(() => tmuxRunInherited(['other-command'], dir));
  assert.equal(JSON.parse(readFileSync(join(dir, 'stats', 'send.json'), 'utf8')).tmuxSendFailures, 1);
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory');
  process.env.PLUK_RUN_DIR = blocked;
  assert.throws(() => tmuxSendKeys(['send-keys', '-t', '=s:', 'Enter']), /Command failed/);
  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.doesNotThrow(() => tmuxRunInherited(['other-command'], dir));
});

test('watch events survive an unusable snapshot directory', t => {
  const dir = scratch(t);
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory');
  const result = spawnSync(process.execPath, [CLI, 'watch', 's', `--run-dir=${blocked}`], {
    encoding: 'utf8', input: 'Error: still works\n', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseLines(result.stdout)[0].type, 'error');
  assert.equal(result.stderr, '');
});
