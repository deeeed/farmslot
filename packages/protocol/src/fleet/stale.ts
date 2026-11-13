import type { FleetStatus } from '../contracts/slots.js';

/**
 * The gateway's default freshness threshold (`FARMSLOT_FLEET_STALE_MS` overrides it there). A full
 * health refresh of the operator fleet (108 slots on three machines) takes 170-215 s (measured
 * 2026-11-12); refreshed at half this, it lands well before the threshold.
 */
export const FLEET_STALE_MS_DEFAULT = 10 * 60_000;

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
