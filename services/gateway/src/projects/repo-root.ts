import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { farmslotRoot, resolveFarmslotRoot, resolveWorkspaceRoot } from '@farmslot/slot-config';

import { isGatewayTestProcess, isolatedTestPath } from '../core/isolated-test-path.js';

// Root and workspace discovery are owned by @farmslot/slot-config (single
// implementation, shared with the CLI); this module re-exports them.
export { farmslotRoot, resolveFarmslotRoot, resolveWorkspaceRoot };

export function resolveStatusFilePath(
  root = farmslotRoot,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  const testPath = env.FARMSLOT_TEST_STATUS_FILE?.trim();
  if (testPath) {
    if (env.NODE_TEST_CONTEXT !== '1') {
      throw new Error('FARMSLOT_TEST_STATUS_FILE is restricted to NODE_TEST_CONTEXT=1');
    }
    return path.resolve(testPath);
  }
  if (isGatewayTestProcess(env, argv)) {
    const isolated = isolatedTestPath('farmslot-test-status', '.json');
    if (!existsSync(isolated)) writeFileSync(isolated, '{"slots":[]}\n');
    return isolated;
  }
  return path.join(root, '.farm-status.json');
}

export const farmslotRuntimeLogDir = path.join(farmslotRoot, '.omx', 'logs');
