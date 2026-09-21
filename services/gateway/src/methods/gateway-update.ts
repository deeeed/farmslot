import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { CheckoutUpdateOperation, GatewayUpdateParams } from '@farmslot/protocol';

import { farmslotRoot } from '../core/index.js';

const exec = promisify(execFile);
async function recordPath(): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['rev-parse', '--git-path', 'farmslot-checkout-update.json'],
    { cwd: farmslotRoot, timeout: 8000 },
  );
  return resolve(farmslotRoot, stdout.trim());
}

async function writeOperation(path: string, operation: CheckoutUpdateOperation): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(operation), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function readCheckoutUpdate(): Promise<CheckoutUpdateOperation | undefined> {
  let path: string;
  try {
    path = await recordPath();
  } catch {
    // Packaged deployments outside Git cannot have a checkout update operation.
    return undefined;
  }
  let operation: CheckoutUpdateOperation;
  try {
    operation = JSON.parse(await readFile(path, 'utf8')) as CheckoutUpdateOperation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (operation.phase === 'running' && Date.now() - Date.parse(operation.updatedAt) > 120_000) {
    // Every Git command has a 30-second deadline. A dead worker must not leave
    // the UI claiming an update is still running after a crash or machine reboot.
    let alive = false;
    if (operation.pid) {
      try {
        process.kill(operation.pid, 0);
        alive = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (!alive) {
      operation = {
        ...operation,
        phase: 'error',
        message: 'The update worker stopped. Refresh the checkout status before retrying.',
      };
      await writeOperation(path, operation);
      await rm(`${path}.lock`, { recursive: true, force: true });
    }
  }
  return operation;
}

export async function gatewayUpdate(params: GatewayUpdateParams): Promise<CheckoutUpdateOperation> {
  if (
    !params ||
    typeof params.localSha !== 'string' ||
    typeof params.targetSha !== 'string' ||
    !/^[a-f0-9]{7,40}$/.test(params.localSha) ||
    !/^[a-f0-9]{7,40}$/.test(params.targetSha)
  )
    throw new Error('Refresh the checkout status before updating.');
  const previous = await readCheckoutUpdate();
  if (previous?.phase === 'running') return previous;
  const path = await recordPath();
  await mkdir(`${path}.lock`);
  const operation: CheckoutUpdateOperation = {
    id: crypto.randomUUID(),
    phase: 'running',
    localSha: params.localSha,
    targetSha: params.targetSha,
    message: 'Starting checkout update…',
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeOperation(path, operation);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../../../scripts/update-checkout.mjs', import.meta.url)),
        farmslotRoot,
        path,
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, NODE_OPTIONS: '' },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return operation;
  } catch (error) {
    await writeOperation(path, {
      ...operation,
      phase: 'error',
      message: 'Could not start the update worker.',
    });
    await rm(`${path}.lock`, { recursive: true, force: true });
    throw error;
  }
}
