import type { ResourcePressureMachine } from '@farmslot/protocol';

type ProcessAttribution = ResourcePressureMachine['processAttribution'];

const attributionByMachine = new Map<string, ProcessAttribution>();
const MAX_CACHED_MACHINES = 64;

/** Cache attribution only when an explicit pressure snapshot already paid for
 * process, resource, and tmux resolution. Dispatch admission reads this cache
 * and never initiates that work itself. */
export function cacheMachinePressureAttribution(
  machine: string,
  attribution: ProcessAttribution,
): void {
  attributionByMachine.delete(machine);
  attributionByMachine.set(machine, structuredClone(attribution));
  while (attributionByMachine.size > MAX_CACHED_MACHINES) {
    attributionByMachine.delete(attributionByMachine.keys().next().value!);
  }
}

export function getCachedMachinePressureAttribution(
  machine: string,
): ProcessAttribution | undefined {
  const attribution = attributionByMachine.get(machine);
  return attribution ? structuredClone(attribution) : undefined;
}

export function resetPressureAttributionCacheForTest(): void {
  attributionByMachine.clear();
}
