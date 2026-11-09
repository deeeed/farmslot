import os from 'node:os';

import { currentFarmPaths, legacyRemoteFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { reportedFarmPaths, type SlotVars } from '@farmslot/slot-config';

import { isLocal } from '../core/exec.js';

export function farmPathsForSlot(vars: Pick<SlotVars, 'machine' | 'machineEnv'>) {
  return reportedFarmPaths(vars.machine) ?? legacyRemoteFarmPaths(vars.machineEnv);
}
export { currentFarmPaths };

/** Legacy local helpers live in the checkout, even after a node registers. */
export function farmslotDirForSlot(vars: SlotVars): string {
  const report = reportedFarmPaths(vars.machine);
  if (report?.layout === 2) return report.code.node;
  const host = vars.host.replace(/\.local$/, '');
  const local = isLocal(vars.host, vars.machine) || host === os.hostname().replace(/\.local$/, '');
  return local
    ? currentFarmPaths('gateway').code.checkout
    : legacyRemoteFarmPaths(vars.machineEnv).code.node;
}
