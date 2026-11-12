import os from 'node:os';

import { currentFarmPaths, legacyRemoteFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { reportedFarmPaths, type SlotVars } from '@farmslot/slot-config';

import { isLocal } from '../core/exec.js';
import { commandIncludesRemotePath } from '../core/remote-paths.js';

export function farmPathsForSlot(vars: Pick<SlotVars, 'machine' | 'machineEnv'>) {
  const report = reportedFarmPaths(vars.machine);
  return report?.layout === 2 ? report : legacyRemoteFarmPaths(vars.machineEnv);
}
export { currentFarmPaths };

/** Hooks may use the configured workspace while framework helpers use the node install. */
export function farmCommandRootsForSlot(vars: Pick<SlotVars, 'machine' | 'machineEnv'>): string[] {
  const { code } = farmPathsForSlot(vars);
  return [...new Set([code.node, code.templateNode])];
}

export function commandIncludesFarmPath(
  command: string,
  vars: Pick<SlotVars, 'machine' | 'machineEnv'>,
): boolean {
  return farmCommandRootsForSlot(vars).some((root) => commandIncludesRemotePath(command, root));
}

/** Legacy local helpers live in the checkout, even after a node registers. */
export function farmslotDirForSlot(
  vars: Pick<SlotVars, 'host' | 'machine' | 'machineEnv'>,
): string {
  const report = reportedFarmPaths(vars.machine);
  if (report?.layout === 2) return report.code.node;
  const host = vars.host.replace(/\.local$/, '');
  const local = isLocal(vars.host, vars.machine) || host === os.hostname().replace(/\.local$/, '');
  return local
    ? currentFarmPaths('gateway').code.checkout
    : legacyRemoteFarmPaths(vars.machineEnv).code.node;
}
