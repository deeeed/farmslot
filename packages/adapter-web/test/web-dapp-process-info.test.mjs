import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { blindBrowserOptions } from '../src/web-dapp/lib/blind-browser.mjs';
import { readNativeProcArgs } from '../src/web-dapp/lib/native-proc-args.mjs';
import { processInfo } from '../src/web-dapp/lib/process-info.mjs';
import {
  ownedProcessIdentity,
  ownerMarker,
  ownsProcess,
  processCommand,
  stopConsoleCollector,
  stopWebDappBrowser,
  terminate,
} from '../src/web-dapp/lib/processes.mjs';
import { resolvePython } from '../src/web-dapp/lib/python.mjs';

test('process inspection preserves argv, group, state and start identity without setuid ps', async (t) => {
  const runtime = '/synthetic/slot';
  const marker = ownerMarker('browser', runtime);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)', '--', marker], {
    detached: true,
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  await once(child, 'spawn');
  const info = processInfo(child.pid);
  assert.ok(info);
  assert.ok(info.argv.includes(marker));
  assert.equal('env' in info, false);
  if (process.platform === 'darwin') {
    const args = readNativeProcArgs(child.pid);
    assert.deepEqual(args.argv, info.argv);
    assert.equal('env' in args, false);
    const withEnv = readNativeProcArgs(child.pid, { includeEnvironment: true });
    assert.deepEqual(withEnv.argv, info.argv);
    assert.ok(withEnv.env.some((entry) => entry.startsWith('PATH=')));
  }
  assert.equal(info.pgid, child.pid);
  assert.ok(info.state);
  assert.ok(info.startedAt);
  assert.equal(processInfo(child.pid).startedAt, info.startedAt);
  assert.ok(processCommand(child.pid).includes(marker));
  assert.equal(ownsProcess('browser', child.pid, runtime), true);
  assert.equal(ownsProcess('browser', child.pid, `${runtime}-other`), false);
  await terminate(child.pid, 100, ownedProcessIdentity('browser', child.pid, runtime));
  assert.equal(processInfo(child.pid), null);
});

test('foreign and embedded owner tokens never establish ownership', async (t) => {
  const runtime = '/synthetic/slot';
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 100)', '--', `embedded ${ownerMarker('browser', runtime)}`],
    { stdio: 'ignore' },
  );
  t.after(async () => {
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  });
  await once(child, 'spawn');
  assert.equal(ownsProcess('browser', child.pid, runtime), false);
  assert.equal(processInfo(-1), null);
  assert.equal(processInfo(99999999), null);
});

test('macOS inspection rejects an unusable interpreter and never calls the install stub', () => {
  assert.throws(
    () => processInfo(process.pid, { platform: 'darwin', python: () => null }),
    /usable python3/u,
  );
  assert.throws(
    () => processInfo(process.pid, { platform: 'darwin', python: () => '/usr/bin/false' }),
    /Command failed/u,
  );
});

test(
  'a slow python3 shim is resolved once to its interpreter, so later probes never wait on it',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const real = spawnSync('/usr/bin/which', ['python3'], { encoding: 'utf8' }).stdout.trim();
    if (!real) return t.skip('no python3 on PATH');
    // An asdf shim on a loaded host: a bash wrapper that takes seconds to start.
    const bin = mkdtempSync(path.join(os.tmpdir(), 'slow-python-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(path.join(bin, 'python3'), `#!/bin/bash\nsleep 3\nexec ${real} "$@"\n`, {
      mode: 0o755,
    });
    const probe = `
      import { usablePython } from ${JSON.stringify(new URL('../src/web-dapp/lib/python.mjs', import.meta.url).href)};
      import { processInfo } from ${JSON.stringify(new URL('../src/web-dapp/lib/process-info.mjs', import.meta.url).href)};
      const python = usablePython();
      const pids = [processInfo(process.pid).pgid, processInfo(process.pid).pgid];
      console.log(JSON.stringify({ python, pids }));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(run.status, 0, run.stderr);
    const { python, pids } = JSON.parse(run.stdout);
    assert.notEqual(python, path.join(bin, 'python3'));
    assert.equal(pids.length, 2);
  },
);

test(
  'a resolved interpreter still passes the stub guard and must be an executable file',
  { skip: process.platform !== 'darwin' },
  () => {
    const calls = [];
    const run = (resolved) => (command, args, env) => {
      calls.push({ command, env });
      if (command === '/usr/bin/which') return '/opt/fake/bin/python3';
      if (command === '/usr/bin/xcode-select') return '';
      return resolved;
    };
    const env = {
      PATH: '/opt/fake/bin',
      PYTHONEXECUTABLE: '/usr/bin/python3',
      __PYVENV_LAUNCHER__: 'x',
    };
    const options = { platform: 'darwin', env };
    assert.equal(resolvePython({ ...options, run: run('/usr/bin/python3') }), null);
    assert.deepEqual(calls.find((call) => call.command === '/opt/fake/bin/python3').env, {
      PATH: '/opt/fake/bin',
    });
    assert.equal(resolvePython({ ...options, run: run('/does/not/exist/python3') }), undefined);
    assert.equal(resolvePython({ ...options, run: run('') }), undefined);
    assert.equal(resolvePython({ ...options, run: run(process.execPath) }), process.execPath);
  },
);

test(
  'python3 resolution ignores PYTHONEXECUTABLE and retries after a failed answer',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const real = spawnSync('/usr/bin/which', ['python3'], { encoding: 'utf8' }).stdout.trim();
    if (!real) return t.skip('no python3 on PATH');
    // A shim that fails its first answer, as one that briefly disappears does.
    const bin = mkdtempSync(path.join(os.tmpdir(), 'flaky-python-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    const once = path.join(bin, 'answered');
    writeFileSync(
      path.join(bin, 'python3'),
      `#!/bin/bash\n[ -e ${once} ] || { touch ${once}; exit 1; }\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const probe = `
      import { usablePython } from ${JSON.stringify(new URL('../src/web-dapp/lib/python.mjs', import.meta.url).href)};
      console.log(JSON.stringify([usablePython(), usablePython()]));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PYTHONEXECUTABLE: '/nope/python3',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const [first, second] = JSON.parse(run.stdout);
    assert.equal(first, null);
    assert.ok(second && second !== '/nope/python3' && existsSync(second), second);
  },
);

test('ordinary browser mode and seatbelt validation are independent of the test runner sandbox', () => {
  assert.deepEqual(blindBrowserOptions({}), { args: [], direct: false });
  assert.throws(
    () =>
      blindBrowserOptions(
        { FARMSLOT_BLIND_SEATBELT: '1' },
        { platform: 'darwin', sandboxed: () => false },
      ),
    /active macOS seatbelt/u,
  );
  assert.deepEqual(
    blindBrowserOptions(
      { FARMSLOT_BLIND_SEATBELT: '1' },
      { platform: 'darwin', sandboxed: () => true },
    ),
    { args: ['--no-sandbox'], direct: true },
  );
  assert.throws(
    () => blindBrowserOptions({ FARMSLOT_BLIND_SEATBELT: 'yes' }),
    /invalid blind seatbelt/u,
  );
});

for (const kind of ['browser', 'wallet-host', 'console-collector']) {
  for (const mismatch of ['startedAt', 'marker']) {
    test(
      `teardown keeps ${kind} ownership records when ${mismatch} changes after authorization`,
      { skip: process.platform !== 'darwin' },
      async (t) => {
        const runtime = mkdtempSync(path.join(os.tmpdir(), 'process-identity-'));
        t.after(() => rmSync(runtime, { recursive: true, force: true }));
        mkdirSync(runtime, { recursive: true });
        const pid = 60000001;
        const pidFile = path.join(
          runtime,
          kind === 'console-collector' ? 'console-tail.pid' : `${kind}.pid`,
        );
        writeFileSync(pidFile, `${pid}\n`);
        for (const file of ['browser.json', 'wallet-host.ready'])
          writeFileSync(path.join(runtime, file), 'fixture');
        const original = childProcess.execFileSync;
        let inspections = 0;
        t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
          if (args?.at(-1) !== String(pid)) return original(file, args, options);
          inspections += 1;
          return JSON.stringify({
            argv: [
              mismatch === 'marker' && inspections > 1 ? '--foreign' : ownerMarker(kind, runtime),
            ],
            pgid: pid,
            state: 2,
            startedAt: mismatch === 'startedAt' && inspections > 1 ? 'replacement' : 'authorized',
          });
        });
        syncBuiltinESMExports();
        t.after(() => {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        });
        const signals = [];
        const kill = process.kill;
        t.mock.method(process, 'kill', (target, signal) => {
          if (Math.abs(target) !== pid) return kill(target, signal);
          if (signal !== 0) {
            signals.push(signal);
            assert.fail('signal sent after ownership changed');
          }
          return true;
        });
        const result =
          kind !== 'console-collector'
            ? await stopWebDappBrowser(runtime, { runtimeDir: runtime })
            : await stopConsoleCollector(runtime, { runtimeDir: runtime });
        assert.deepEqual(signals, []);
        assert.deepEqual(
          result.foreign,
          kind === 'console-collector' ? pid : [{ name: kind, pid }],
        );
        assert.equal(readFileSync(pidFile, 'utf8'), `${pid}\n`);
        if (kind !== 'console-collector') {
          assert.equal(existsSync(path.join(runtime, 'browser.json')), true);
          assert.equal(existsSync(path.join(runtime, 'wallet-host.ready')), true);
        }
      },
    );
  }
}

for (const mismatch of ['startedAt', 'marker']) {
  test(
    `termination revalidates ${mismatch} before escalating to SIGKILL`,
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const pid = 60000001;
      const marker = ownerMarker('browser', '/synthetic/escalation');
      const identity = {
        pid,
        marker,
        argv: [marker],
        pgid: pid,
        state: 2,
        startedAt: 'authorized',
      };
      let reads = 0;
      const original = childProcess.execFileSync;
      t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
        if (args?.at(-1) !== String(pid)) return original(file, args, options);
        reads += 1;
        return JSON.stringify(
          reads === 1
            ? identity
            : {
                ...identity,
                startedAt: mismatch === 'startedAt' ? 'replacement' : identity.startedAt,
                argv: mismatch === 'marker' ? ['--foreign'] : identity.argv,
              },
        );
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const signals = [];
      const kill = process.kill;
      t.mock.method(process, 'kill', (target, signal) => {
        if (Math.abs(target) !== pid) return kill(target, signal);
        if (signal !== 0) signals.push(signal);
        return true;
      });
      assert.equal(await terminate(pid, 0, identity), false);
      assert.deepEqual(signals, ['SIGTERM']);
      assert.equal(reads, 2);
    },
  );
}
