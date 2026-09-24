import { test } from 'node:test';
import assert from 'node:assert';
import { buildSendCommands } from '../dist/send.js';

test('default (no flags) keeps tmux key-name lookup', () => {
  const cmds = buildSendCommands({ session: 's1', text: 'C-c' });
  assert.deepStrictEqual(cmds, [['send-keys', '-t', 's1', 'C-c']]);
});

test('--literal sends text with -l', () => {
  const cmds = buildSendCommands({ session: 's1', text: 'Enter', literal: true });
  assert.deepStrictEqual(cmds, [['send-keys', '-l', '-t', 's1', 'Enter']]);
});

test('--enter sends literal text then a separate Enter keypress', () => {
  const cmds = buildSendCommands({ session: 's1', text: 'hello', enter: true });
  assert.deepStrictEqual(cmds, [
    ['send-keys', '-l', '-t', 's1', 'hello'],
    ['send-keys', '-t', 's1', 'Enter'],
  ]);
});

test('--literal --enter never appends Enter inside the -l call', () => {
  const cmds = buildSendCommands({ session: 's1', text: 'hi', literal: true, enter: true });
  assert.deepStrictEqual(cmds, [
    ['send-keys', '-l', '-t', 's1', 'hi'],
    ['send-keys', '-t', 's1', 'Enter'],
  ]);
});

test('special characters pass through unmodified (no shell escaping)', () => {
  const text = 'don\'t stop! "$HOME" `id` \\path\\ ;rm -rf';
  const cmds = buildSendCommands({ session: 's1', text, enter: true });
  assert.strictEqual(cmds[0][cmds[0].length - 1], text);
});

test('session name with spaces/metacharacters is a single argv entry', () => {
  const session = 'my agent; echo pwned';
  const cmds = buildSendCommands({ session, text: 'x', enter: true });
  assert.strictEqual(cmds[0][3], session);
  assert.strictEqual(cmds[1][2], session);
});
