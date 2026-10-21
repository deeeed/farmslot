import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, utimes } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

/** Stop only this checkout's selected dev gateway, always restarting its surviving watcher. */
export async function withOwnedGatewayOffline(prove, { beforeStop } = {}) {
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
  async function listening() {
    let current;
    try {
      const result = await execute('lsof', ['-t', `-iTCP:${gateway.port}`, '-sTCP:LISTEN'], {
        timeout: 3000,
      });
      current = Number(result.stdout.trim());
    } catch (error) {
      if (error.code === 1 && error.stdout === '') return false;
      throw error;
    }
    assert(Number.isSafeInteger(current) && current > 0, 'Expected one gateway listener');
    let identity;
    let currentParent;
    try {
      identity = await execute('lsof', ['-a', '-p', String(current), '-d', 'cwd', '-Fn'], {
        timeout: 3000,
      });
      currentParent = await execute('ps', ['-p', String(current), '-o', 'ppid='], {
        timeout: 3000,
      });
    } catch (error) {
      // A source reload can retire the listener between these observations. Retry that state.
      if (error.code === 1 && error.stdout === '') return undefined;
      throw error;
    }
    assert(
      identity.stdout.split('\n').includes(`n${root}/services/gateway`) &&
        currentParent.stdout.trim() === parent.trim(),
      'The listener must retain its checkout and source watcher',
    );
    return true;
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
  let suspended = false;
  let suspendedWatcher = false;
  let restartPrepared = false;
  async function recover(proofError) {
    try {
      if (suspended && !stopped) {
        try {
          process.kill(pid, 'SIGCONT');
        } catch (error) {
          // A watcher may have retired the stopped child before a failed proof.
          // Treat its native absence as terminal and still verify recovery.
          if (error.code !== 'ESRCH') throw error;
          stopped = true;
        }
      }
      if (suspendedWatcher) process.kill(Number(parent.trim()), 'SIGCONT');
      if (stopped || restartPrepared) {
        // Touch the watched entry without changing bytes or starting another server.
        if (!restartPrepared) {
          const now = new Date();
          await utimes(entry, now, now);
        }
        await waitForPort(true);
        assert.equal(hash(await readFile(entry)), original);
      }
    } catch (error) {
      if (proofError)
        throw new AggregateError([proofError, error], 'Gateway proof and recovery both failed');
      throw error;
    }
  }
  let proofError;
  try {
    if (beforeStop) {
      // Keep a real command pending before crashing this private gateway. SIGKILL
      // closes a stopped process without letting it finish the queued request.
      process.kill(pid, 'SIGSTOP');
      suspended = true;
      await beforeStop();
      // tsx watch subscribes to the child's exit only when a restart starts.
      // Allow its 100-ms debounce before suspending it, keeping the child
      // stopped throughout. Finally verifies the actual watcher restart.
      const now = new Date();
      await utimes(entry, now, now);
      restartPrepared = true;
      await delay(1000);
      const childState = await execute('ps', ['-p', String(pid), '-o', 'stat=']);
      assert(childState.stdout.trim().startsWith('T'), 'The owned gateway must remain stopped');
      process.kill(Number(parent.trim()), 'SIGSTOP');
      suspendedWatcher = true;
      const state = await execute('ps', ['-p', parent.trim(), '-o', 'stat=']);
      assert(state.stdout.trim().startsWith('T'), 'The owned watcher must be suspended');
    }
    process.kill(pid, beforeStop ? 'SIGKILL' : 'SIGTERM');
    stopped = true;
    await waitForPort(false);
    return { stoppedPid: pid, evidence: await prove() };
  } catch (error) {
    proofError = error;
    throw error;
  } finally {
    await recover(proofError);
  }
}
