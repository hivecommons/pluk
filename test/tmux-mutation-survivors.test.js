// Pins the src/tmux.ts behaviour the nightly Mutation (advisory) run left
// unasserted without a tmux binary: the full pipe-pane overflow message,
// the send-keys-only failure counter, and the trim/blank-line handling of
// tmuxListSessionNames. Every tmux call here goes to a shell stub on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TMUX_FORMAT_BUFFER_BYTES,
  assertPipePaneCommandFits,
  tmuxListSessionNames,
  tmuxRunInherited,
} from '../dist/tmux.js';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pluk-tmux-survivors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stubTmux(t, dir, script) {
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = savedPath; });
}

const sendFailures = dir => JSON.parse(readFileSync(join(dir, 'stats', 'send.json'), 'utf8')).tmuxSendFailures;

test('assertPipePaneCommandFits names the size, the limit, the consequence and every input to shorten', () => {
  const overflow = 'x'.repeat(TMUX_FORMAT_BUFFER_BYTES);
  assert.throws(() => assertPipePaneCommandFits(overflow), error => {
    assert.equal(
      error.message,
      `pipe-pane command is ${TMUX_FORMAT_BUFFER_BYTES} bytes after tmux format escaping; `
      + `tmux drops commands of ${TMUX_FORMAT_BUFFER_BYTES} bytes or more and would `
      + 'silently turn event logging off. Shorten PLUK_LOG_MAX_BYTES / PLUK_LOG_KEEP_LINES '
      + '(the inputs most likely to overflow it), the run directory, session name, '
      + 'CLI name or log path.',
    );
    return true;
  });
});

test('assertPipePaneCommandFits reports the strftime size, so %% pairs count once and ## pairs twice', () => {
  // 8190 'x' + '%' → escaped '%%' → strftime output 8191 bytes: fits.
  const fits = `${'x'.repeat(TMUX_FORMAT_BUFFER_BYTES - 2)}%`;
  assert.equal(assertPipePaneCommandFits(fits), `${'x'.repeat(TMUX_FORMAT_BUFFER_BYTES - 2)}%%`);
  // 8190 'x' + '#' → escaped '##' survives strftime as 8192 bytes: refused.
  const tooLong = `${'x'.repeat(TMUX_FORMAT_BUFFER_BYTES - 2)}#`;
  assert.throws(
    () => assertPipePaneCommandFits(tooLong),
    { message: new RegExp(`^pipe-pane command is ${TMUX_FORMAT_BUFFER_BYTES} bytes after tmux format escaping`) },
  );
});

test('a failing non-send-keys command does not count against the send-failure counter', t => {
  const dir = scratch(t);
  stubTmux(t, dir, 'exit 0');
  tmuxRunInherited(['send-keys', '-t', '=s:', 'Enter'], dir);
  const before = sendFailures(dir);

  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.throws(() => tmuxRunInherited(['pipe-pane', '-t', '=s:', 'cat'], dir));

  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  tmuxRunInherited(['send-keys', '-t', '=s:', 'Enter'], dir);
  assert.equal(sendFailures(dir), before, 'only a failing send-keys increments the counter');
});

test('tmuxListSessionNames trims each line and drops blank ones', t => {
  const dir = scratch(t);
  stubTmux(t, dir, "printf '  alpha  \\n\\n\\tbeta\\n   \\ngamma\\n'");
  assert.deepEqual(tmuxListSessionNames(), ['alpha', 'beta', 'gamma']);
});

test('tmuxListSessionNames returns no names when tmux prints nothing', t => {
  const dir = scratch(t);
  stubTmux(t, dir, 'exit 0');
  assert.deepEqual(tmuxListSessionNames(), []);
});
