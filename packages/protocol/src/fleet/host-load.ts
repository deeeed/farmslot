/**
 * Re-attaches hostLoad to slot entities from the machines array (ADR-071 Amendment 4).
 *
 * slotEntityBody strips hostLoad before hashing because it is derived from MachineHealth
 * and changes on every node-health refresh, causing spurious entity version churn.
 * The client reassembles it from the machines array the versions read returns, so both
 * the full-read path and the entity-sync path agree on the final SlotStatus shape.
 */
import type { MachineHealth, SlotEntity, SlotStatus } from '../contracts/slots.js';

/**
 * Map SlotEntity[] → SlotStatus[] by re-attaching hostLoad from the machines array.
 *
 * Uses slot.machine to look up the matching MachineHealth entry.
 * When a slot's machine is not found in machines, or the machine has no system metrics,
 * hostLoad is left absent (which is valid — SlotStatus.hostLoad is optional).
 */
export function reattachHostLoad(
  entities: SlotEntity[],
  machines: MachineHealth[] | undefined,
): SlotStatus[] {
  if (!machines?.length) {
    // SlotEntity is Omit<SlotStatus, 'hostLoad'>; hostLoad is optional in SlotStatus,
    // so SlotEntity satisfies SlotStatus structurally — no cast needed.
    return entities;
  }
  const machineMap = new Map(machines.map((m) => [m.machine, m]));
  return entities.map((entity) => {
    const mh = machineMap.get(entity.machine);
    if (!mh?.system) return entity;
    return {
      ...entity,
      hostLoad: {
        cpuPercent: mh.system.cpuPercent,
        memoryPercent: mh.system.memoryPercent,
        diskPercent: mh.system.diskPercent,
        headroom: mh.headroom,
      },
    };
  });
}
