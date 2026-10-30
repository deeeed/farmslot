import { Methods, type ProviderAccountsSnapshotResult, type SlotStatus } from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

/** The gateway's limit on machines named in one seats read. */
const MAX_NAMED_MACHINES = 64;

/**
 * Runner seats for the machines the fleet shows. The all-machines read finds its machines from
 * every slot row, so any slot change rereads it; naming the machines leaves only their seats.
 */
export function fleetSeatsQuery(
  slots: readonly SlotStatus[],
): ResourceQuery<ProviderAccountsSnapshotResult> | undefined {
  const machines = [...new Set(slots.map((slot) => slot.machine))].sort();
  if (!machines.length) return undefined;
  return resourceQuery<ProviderAccountsSnapshotResult>(
    Methods.PROVIDER_ACCOUNTS_SNAPSHOT,
    machines.length > MAX_NAMED_MACHINES ? undefined : { machines },
  );
}
