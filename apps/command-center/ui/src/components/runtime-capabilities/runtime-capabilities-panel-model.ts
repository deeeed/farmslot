import type { RuntimeCapabilityLease } from '@farmslot/protocol';

const PROVIDER_HOLDER_STATES = new Set<RuntimeCapabilityLease['state']>([
  'acquiring',
  'acquired',
  'releasing',
]);

export function projectRuntimeCapabilityLeases(leases: RuntimeCapabilityLease[]): {
  providerHolder: RuntimeCapabilityLease | undefined;
  queuedReservations: RuntimeCapabilityLease[];
} {
  let providerHolder: RuntimeCapabilityLease | undefined;
  const queuedReservations: RuntimeCapabilityLease[] = [];
  for (const lease of leases) {
    if (PROVIDER_HOLDER_STATES.has(lease.state)) providerHolder = lease;
    else if (lease.state === 'queued') queuedReservations.push(lease);
  }
  return { providerHolder, queuedReservations };
}
