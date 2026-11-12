import type { FleetStatus } from '../contracts/slots.js';

/**
 * A fleet whose snapshot is older than the gateway's freshness threshold: marked stale, with no
 * slot dispatchable. The gateway decides staleness; it and the client cache apply this one rule.
 */
export function staleFleet<T extends FleetStatus>(fleet: T): T {
  return {
    ...fleet,
    stale: true,
    slots: fleet.slots.map((slot) => ({ ...slot, dispatchable: false })),
  };
}
