import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { farmslotRoot, resolveFarmslotRoot, resolveWorkspaceRoot } from '@farmslot/slot-config';

import { isGatewayTestProcess, isolatedTestPath } from '../core/isolated-test-path.js';

// Root and workspace discovery are owned by @farmslot/slot-config (single
// implementation, shared with the CLI); this module re-exports them.
export { farmslotRoot, resolveFarmslotRoot, resolveWorkspaceRoot };

let gatewayStatusProcess = false;

/** Explicit gateway bootstrap, never an environment flag inherited by child scripts. */
export function registerGatewayStatusProcess(): void {
  gatewayStatusProcess = true;
}

function canonicalStatusPath(file: string): string {
  const resolved = path.resolve(file);
  if (existsSync(resolved)) return realpathSync(resolved);
  const parent = path.dirname(resolved);
  return existsSync(parent) ? path.join(realpathSync(parent), path.basename(resolved)) : resolved;
}

export function resolveStatusFilePath(
  root = farmslotRoot,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  gatewayProcess = gatewayStatusProcess,
): string {
  const testPath = env.FARMSLOT_TEST_STATUS_FILE?.trim();
  if (testPath) {
    if (env.NODE_TEST_CONTEXT !== '1') {
      throw new Error('FARMSLOT_TEST_STATUS_FILE is restricted to NODE_TEST_CONTEXT=1');
    }
    const selected = canonicalStatusPath(testPath);
    // A private FARMSLOT_ROOT cannot authorize an inherited path into another farm.
    const sharedFarm =
      path.basename(selected) === '.farm-status.json' &&
      ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'].every((marker) =>
        existsSync(path.join(path.dirname(selected), marker)),
      );
    if (selected === canonicalStatusPath(path.join(root, '.farm-status.json')) || sharedFarm)
      throw new Error('Test status path must not point to the shared fleet status store');
    return path.resolve(testPath);
  }
  if (isGatewayTestProcess(env, argv)) {
    const isolated = isolatedTestPath('farmslot-test-status', '.json');
    if (!existsSync(isolated)) writeFileSync(isolated, '{"slots":[]}\n');
    return isolated;
  }
  if (!gatewayProcess)
    throw new Error(
      'Shared fleet status access requires gateway bootstrap; use gateway RPC or an isolated test store',
    );
  return path.join(root, '.farm-status.json');
}

export const farmslotRuntimeLogDir = path.join(farmslotRoot, '.omx', 'logs');
