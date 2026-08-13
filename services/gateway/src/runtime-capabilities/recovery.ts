import type { RuntimeCapabilityRegistry } from './registry.js';

/** Startup reconciliation is explicit so validation gateways can opt out. */
export async function reconcileRuntimeCapabilityLeases(
  registry: RuntimeCapabilityRegistry,
  slotIds?: string[],
): Promise<void> {
  await registry.recover(slotIds);
}
