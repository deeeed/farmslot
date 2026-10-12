import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
