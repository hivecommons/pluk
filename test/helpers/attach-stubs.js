import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

export function writeStub(dir, name, script) {
  const file = join(dir, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

// Builds the stub-bin harness shared by the attach tests. Stub dirs and run
// dirs are created under `scratch`; `defaults` seeds makeStubs() options for
// files whose stubs differ from the common layout.
export function createAttachHarness(scratch, defaults = {}) {
  // Builds a fresh stub-bin dir. Every stub appends its argv to <name>.log so
  // tests can assert on exactly what attach() executed.
  function makeStubs(options = {}) {
    const {
      hasSession = false,        // fake tmux `has-session` result
      which = ['tmux'],          // names the fake `which` resolves (to their stubs)
      whichEchoesStubPaths = false, // fake `which` also echoes absolute stub-dir paths
      npxOk = false,             // fake npx exit status (pluk npx fallback probe)
      pgrepPids = '',            // fake pgrep stdout ('' => exit 1, "no watchers")
      pgrepExpandsVars = false,  // double-quote pgrepPids so $PPID expands to attach's PID
      osascriptOk = true,        // fake osascript exit status
      tmuxAttachOk = true,       // fake tmux `attach` result
      rgSleep = 0,               // seconds the fake rationguard stays alive
      rgPidFile = '',            // file the fake rationguard writes its PID to (then sleeps)
      killFailPid = '',          // PID the fake kill reports as already gone (exit 1)
      killDenyPid = '',          // PID the fake kill refuses with EPERM (exit 1)
      plukClassify = false,      // also stub a pluk-classify binary
      dirName = '',              // fixed stub-dir name, for hostile-path tests
    } = { ...defaults, ...options };
    let dir;
    if (dirName) {
      dir = join(scratch, dirName);
      mkdirSync(dir);
    } else {
      dir = mkdtempSync(join(scratch, 'stub-'));
    }
    const logFor = name => join(dir, `${name}.log`);

    writeStub(dir, 'tmux', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('tmux')}'
[ "$1" = "has-session" ] && exit ${hasSession ? 0 : 1}
[ "$1" = "attach" ] && exit ${tmuxAttachOk ? 0 : 1}
exit 0
`);
    writeStub(dir, 'which', `#!/bin/sh
case "$1" in
  ${which.join('|') || 'nothing-resolves'}) echo '${dir}'/"$1"; exit 0 ;;
${whichEchoesStubPaths ? `  '${dir}'/*) echo "$1"; exit 0 ;;\n` : ''}  *) exit 1 ;;
esac
`);
    writeStub(dir, 'npx', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('npx')}'
exit ${npxOk ? 0 : 1}
`);
    // With pgrepExpandsVars, $PPID is the attach process itself: pgrep is run
    // from it via execFileSync.
    const pgrepOut = pgrepExpandsVars ? `"${pgrepPids}"` : `'${pgrepPids}'`;
    writeStub(dir, 'pgrep', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('pgrep')}'
${pgrepPids ? `printf '%s\\n' ${pgrepOut}\nexit 0` : 'exit 1'}
`);
    writeStub(dir, 'kill', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('kill')}'
${killFailPid ? `[ "$1" = '${killFailPid}' ] && { echo 'kill: (${killFailPid}) - No such process' >&2; exit 1; }` : ''}
${killDenyPid ? `[ "$1" = '${killDenyPid}' ] && { echo 'kill: (${killDenyPid}) - Operation not permitted' >&2; exit 1; }` : ''}
exit 0
`);
    writeStub(dir, 'osascript', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('osascript')}'
exit ${osascriptOk ? 0 : 1}
`);
    writeStub(dir, 'pluk', '#!/bin/sh\nexit 0\n');
    if (plukClassify) writeStub(dir, 'pluk-classify', '#!/bin/sh\nexit 0\n');
    writeStub(dir, 'rationguard', `#!/bin/sh
printf '%s\\n' "$*" >> '${logFor('rationguard')}'
${rgPidFile ? `echo $$ > '${rgPidFile}'\nexec sleep 10` : `sleep ${rgSleep}\nexit 0`}
`);

    return {
      dir,
      log: name => {
        try { return readFileSync(logFor(name), 'utf-8'); } catch { return ''; }
      },
    };
  }

  function runAttach(args, stubs, env = {}) {
    const childEnv = {
      ...process.env,
      PATH: `${stubs.dir}:${process.env.PATH}`,
      TERM_PROGRAM: '',
      ...env,
    };
    // An explicit `undefined` value means "delete this variable".
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
    }
    const res = spawnSync(process.execPath, [CLI, 'attach', ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      env: childEnv,
    });
    return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  function makeRunDir() {
    return mkdtempSync(join(scratch, 'run-'));
  }

  return { makeStubs, runAttach, makeRunDir };
}
