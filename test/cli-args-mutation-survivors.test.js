import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_FLAGS, KNOWN_FLAGS, parseArgs } from '../dist/cli-args.js';

function parseWithMockedExit(t, command, args) {
  const exit = new Error('parser exit');
  const state = { exitCode: undefined, diagnostic: '', exit };
  t.mock.method(process, 'exit', code => { state.exitCode = code; throw exit; });
  t.mock.method(console, 'error', message => { state.diagnostic += message; });
  state.parse = () => parseArgs(args, COMMAND_FLAGS[command], command);
  return state;
}

for (const flag of ['command', 'cli-args', 'rebuttal']) {
  for (const value of ['', '   ']) {
    test(`attach rejects --${flag}=${JSON.stringify(value)} as an empty value`, t => {
      const s = parseWithMockedExit(t, 'attach', [`--${flag}=${value}`]);
      assert.throws(s.parse, error => error === s.exit);
      assert.equal(s.exitCode, 2);
      assert.ok(s.diagnostic.includes(`--${flag} requires a non-empty value`));
    });
  }
}

const boolFlags = [
  ['attach', 'verbose'], ['attach', 'rationguard'], ['attach', 'no-raw'],
  ['attach', 'no-open'], ['sessions', 'json'], ['send', 'literal'],
];
for (const [command, flag] of boolFlags) {
  test(`${command} rejects --${flag}=yes as a non-boolean value`, t => {
    const s = parseWithMockedExit(t, command, [`--${flag}=yes`]);
    assert.throws(s.parse, error => error === s.exit);
    assert.equal(s.exitCode, 2);
    assert.ok(s.diagnostic.includes(`--${flag} is a boolean flag: use --${flag} or --${flag}=false`));
  });

  test(`${command} accepts --${flag}, --${flag}=true and --${flag}=false`, t => {
    const s = parseWithMockedExit(t, command, []);
    assert.equal(parseArgs([`--${flag}`], COMMAND_FLAGS[command], command).flags[flag], 'true');
    assert.equal(parseArgs([`--${flag}=true`], COMMAND_FLAGS[command], command).flags[flag], 'true');
    assert.equal(parseArgs([`--${flag}=false`], COMMAND_FLAGS[command], command).flags[flag], 'false');
    assert.equal(s.exitCode, undefined);
  });
}

test('KNOWN_FLAGS is the non-empty union of every COMMAND_FLAGS set', () => {
  const union = new Set(Object.values(COMMAND_FLAGS).flatMap(flags => [...flags]));
  assert.ok(KNOWN_FLAGS.size > 0);
  assert.deepEqual([...KNOWN_FLAGS].sort(), [...union].sort());
  for (const flag of ['cli', 'json', 'literal', 'from-beginning', 'patterns-dir']) {
    assert.ok(KNOWN_FLAGS.has(flag), `KNOWN_FLAGS has --${flag}`);
  }
});
