import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function groupAlive(pid) {
  try {
    return processAlive(-pid);
  } catch (error) {
    // macOS can report EPERM while a terminated group is being reaped.
    // Keep polling; only ESRCH confirms the group is gone.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function providerDaemonPid(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')).pid;
}

export async function waitForProof(read, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Proof condition timed out');
}

export function stopProofGateway(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function proofRPC(root, port, method, params = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
          FARMSLOT_RPC_TIMEOUT_MS: '45000',
        },
      },
    ),
  );
}
