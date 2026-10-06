// Test-only preload for CLI subprocesses:
//   PLUK_TEST_FAULT=<kind> node --import ./test/fixtures/inject-fault.mjs dist/cli.js watch ...
//
// Fires one asynchronous fault into the running process shortly after the
// command has started (so its process-level guards are already installed),
// then prints a marker on stderr so the test knows the fault has landed.
// Nothing here touches the production source; it only reproduces, from
// outside, the kinds of failure a long-lived `pluk watch` pipe-pane process
// must survive:
//
//   throw        — an uncaught exception thrown from a timer callback
//   reject       — an unhandled promise rejection
//   stdin-error  — an 'error' event on process.stdin (EIO when the pane dies)
const kind = process.env['PLUK_TEST_FAULT'] ?? '';
const delayMs = Number(process.env['PLUK_TEST_FAULT_DELAY_MS']) || 50;

export const FAULT_MARKER = 'PLUK_TEST_FAULT_INJECTED';

setTimeout(() => {
  process.stderr.write(`${FAULT_MARKER}:${kind}\n`);
  switch (kind) {
    case 'throw':
      throw new Error('synthetic uncaught exception');
    case 'reject':
      Promise.reject(new Error('synthetic unhandled rejection'));
      break;
    case 'stdin-error':
      process.stdin.emit('error', new Error('synthetic EIO on stdin'));
      break;
    default:
      break;
  }
}, delayMs);
