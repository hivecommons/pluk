import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { COMMAND_FLAGS, KNOWN_FLAGS, parseArgs } from '../dist/cli-args.js';

const CLI = new URL('../dist/cli.js', import.meta.url);
function run(...args) {
  const result = spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}

// Read only the Usage block, not examples or the implementation allowlists.
const help = run('--help');
assert.equal(help.status, 0);
const usage = help.stdout.split('Usage:')[1].split('Commands:')[0];
const documented = new Map([...usage.matchAll(/^  pluk (\w+)(.*)$/gm)].map(([, command, flags]) => [
  command, new Set([...flags.matchAll(/--([a-z][a-z-]*)/g)].map(([, flag]) => flag)),
]));

test('Usage lists every canonical command in the parser contract', () => {
  assert.deepEqual([...documented.keys()].sort(), Object.keys(COMMAND_FLAGS).sort());
});

// Include both unions: removing the final implementation of a documented flag
// (or adding a new implementation without help) must still fail the contract.
const union = new Set([...KNOWN_FLAGS, ...[...documented.values()].flatMap(flags => [...flags])]);
for (const [command, flags] of documented) {
  for (const flag of union) {
    test(`${command} ${flags.has(flag) ? 'accepts' : 'rejects'} --${flag}`, t => {
      const exit = new Error('parser exit');
      let exitCode;
      let diagnostic = '';
      t.mock.method(process, 'exit', code => { exitCode = code; throw exit; });
      t.mock.method(console, 'error', message => { diagnostic += message; });
      // =true is syntactically valid for every flag kind. Semantic validation
      // belongs to the command; this test stops at parsing, with no tmux, file
      // writes, timers, or network calls.
      const parse = () => parseArgs([`--${flag}=true`], COMMAND_FLAGS[command], command);
      if (flags.has(flag)) {
        assert.equal(parse().flags[flag], 'true');
        assert.equal(exitCode, undefined);
      } else {
        assert.throws(parse, error => error === exit);
        assert.equal(exitCode, 2);
        assert.ok(diagnostic.includes(`unknown flag --${flag} for "pluk ${command}" (see pluk ${command} --help)`));
      }
    });
  }
}

test('CLI dispatch enforces command allowlists before doing work (including aliases)', () => {
  for (const command of [...documented.keys(), 'ls', 'classify']) {
    const flag = ['attach', 'watch', 'classify', 'patterns'].includes(command) ? 'enter' : 'cli';
    for (const arg of [`--${flag}`, `--${flag}=true`, '--not-a-pluk-flag']) {
      const result = run(command, arg);
      assert.equal(result.status, 2, `${command} ${arg}: ${result.stderr}`);
      const canonical = { ls: 'sessions', classify: 'watch' }[command] ?? command;
      assert.ok(result.stderr.includes(`for "pluk ${canonical}" (see pluk ${canonical} --help)`));
    }
  }
});

test('help remains available on every subcommand', () => {
  for (const command of documented.keys()) {
    const result = run(command, '--help');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  }
});
