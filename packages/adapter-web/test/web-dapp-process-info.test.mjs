import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { blindBrowserOptions } from '../src/web-dapp/lib/blind-browser.mjs';
import { processInfo } from '../src/web-dapp/lib/process-info.mjs';
import {
  ownerMarker,
  ownsProcess,
  processCommand,
  terminate,
} from '../src/web-dapp/lib/processes.mjs';

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
  assert.equal(info.pgid, child.pid);
  assert.ok(info.state);
  assert.ok(info.startedAt);
  assert.equal(processInfo(child.pid).startedAt, info.startedAt);
  assert.ok(processCommand(child.pid).includes(marker));
  assert.equal(ownsProcess('browser', child.pid, runtime), true);
  assert.equal(ownsProcess('browser', child.pid, `${runtime}-other`), false);
  await terminate(child.pid, 100);
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
