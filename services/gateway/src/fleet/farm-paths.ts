import { currentFarmPaths, legacyRemoteFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { reportedFarmPaths, type SlotVars } from '@farmslot/slot-config';

export function farmPathsForSlot(vars: Pick<SlotVars, 'machine' | 'machineEnv'>) {
  return reportedFarmPaths(vars.machine) ?? legacyRemoteFarmPaths(vars.machineEnv);
}
export { currentFarmPaths };
