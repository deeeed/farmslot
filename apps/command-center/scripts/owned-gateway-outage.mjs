import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, utimes } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

/** Stop only this checkout's selected dev gateway, always restarting its surviving watcher. */
export async function withOwnedGatewayOffline(prove) {
  assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1', 'Explicitly select gateway outage proof');
  assert(
    process.env.FARMSLOT_HOME && process.env.FARMSLOT_GATEWAY_PROFILE,
    'Select an isolated home and profile',
  );
  const profile = await automationGatewayTarget();
  const gateway = new URL(profile.url);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname));
  assert.equal(
    Number(gateway.port),
    Number(process.env.GATEWAY_PORT),
    'Select the owned gateway port',
  );
  const { stdout: listeners } = await execute('lsof', [
    '-t',
    `-iTCP:${gateway.port}`,
    '-sTCP:LISTEN',
  ]);
  const pid = Number(listeners.trim());
  assert(Number.isSafeInteger(pid) && pid > 0, 'Expected exactly one owned gateway listener');
  const { stdout: cwd } = await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const { stdout: command } = await execute('ps', ['-p', String(pid), '-o', 'command=']);
  assert(
    cwd.split('\n').includes(`n${root}/services/gateway`) &&
      command.includes(`${root}/node_modules/tsx/`),
    'The listener must belong to this checkout',
  );
  const { stdout: parent } = await execute('ps', ['-p', String(pid), '-o', 'ppid=']);
  const { stdout: watcher } = await execute('ps', ['-p', parent.trim(), '-o', 'command=']);
  assert(
    watcher.includes(' watch ') &&
      watcher.includes('src/index.ts') &&
      watcher.includes(`${root}/node_modules/`),
    'The owned gateway must have a surviving source watcher',
  );
  const entry = `${root}/services/gateway/src/index.ts`;
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const original = hash(await readFile(entry));
  function listening() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(gateway.port) });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (error) => {
        socket.destroy();
        if (['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) resolve(false);
        else reject(error);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error('Gateway port probe timed out'));
      });
    });
  }
  async function waitForPort(expected) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if ((await listening()) === expected) return;
      await delay(50);
    }
    assert.fail(`Owned gateway did not become ${expected ? 'online' : 'offline'}`);
  }
  let stopped = false;
  try {
    process.kill(pid, 'SIGTERM');
    stopped = true;
    await waitForPort(false);
    return { stoppedPid: pid, evidence: await prove() };
  } finally {
    if (stopped) {
      // Touch the watched entry without changing bytes or starting another server.
      const now = new Date();
      await utimes(entry, now, now);
      await waitForPort(true);
      assert.equal(hash(await readFile(entry)), original);
    }
  }
}
