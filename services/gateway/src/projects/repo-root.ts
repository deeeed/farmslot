import path from 'node:path';

import { farmslotRoot, resolveFarmslotRoot, resolveWorkspaceRoot } from '@farmslot/slot-config';

// Root and workspace discovery are owned by @farmslot/slot-config (single
// implementation, shared with the CLI); this module re-exports them.
export { farmslotRoot, resolveFarmslotRoot, resolveWorkspaceRoot };

export function resolveStatusFilePath(
  root = farmslotRoot,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const testPath = env.FARMSLOT_TEST_STATUS_FILE?.trim();
  if (!testPath) return path.join(root, '.farm-status.json');
  if (env.NODE_TEST_CONTEXT !== '1') {
    throw new Error('FARMSLOT_TEST_STATUS_FILE is restricted to NODE_TEST_CONTEXT=1');
  }
  return path.resolve(testPath);
}

export const farmslotRuntimeLogDir = path.join(farmslotRoot, '.omx', 'logs');
