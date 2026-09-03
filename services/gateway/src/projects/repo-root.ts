import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { farmslotRoot, resolveFarmslotRoot } from '@farmslot/slot-config';

// Root discovery is owned by @farmslot/slot-config (single implementation);
// this module re-exports it and keeps only the gateway workspace logic.
export { farmslotRoot, resolveFarmslotRoot };

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

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

/**
 * Resolve the install workspace root this gateway belongs to, mirroring the CLI's
 * onboarding `resolveWorkspace` contract: FARMSLOT_WORKSPACE env → parent dir of the
 * farmslot clone that holds state.json. The gateway does not depend on @farmslot/cli,
 * so the algorithm is duplicated here; keep the two in sync.
 *
 * Returns null for a plain dev checkout with no surrounding workspace so callers can
 * leave FARMSLOT_WORKSPACE unset and let downstream defaults apply.
 */
export function resolveWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  root = farmslotRoot,
): string | null {
  const fromEnv = env.FARMSLOT_WORKSPACE;
  if (fromEnv) return path.resolve(expandTilde(fromEnv));
  const parent = path.dirname(root);
  if (existsSync(path.join(parent, 'state.json'))) return parent;
  return null;
}
