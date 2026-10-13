import type {
  Run,
  RunSlotCapabilityRequirements,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityListResult,
} from '@farmslot/protocol';

import { claimsDevice } from '../runtime-capabilities/device-target.js';

export type SlotCapabilityCatalogs = ReadonlyMap<string, readonly RuntimeCapabilityCatalogEntry[]>;

async function listSlotCapabilities(slotId: string): Promise<RuntimeCapabilityListResult> {
  const { runtimeCapabilityList } = await import('../methods/runtime-capabilities.js');
  return runtimeCapabilityList({ slotId });
}

/** Capture the typed device intent before replay drops the old slot binding. */
export async function replaySlotCapabilityRequirements(
  run: Pick<Run, 'slotId' | 'engineState'>,
  list: (slotId: string) => Promise<RuntimeCapabilityListResult> = listSlotCapabilities,
): Promise<RunSlotCapabilityRequirements | undefined> {
  if (run.engineState?.slotCapabilityRequirements)
    return structuredClone(run.engineState.slotCapabilityRequirements);
  if (!run.slotId) return undefined;
  const catalog = await list(run.slotId);
  const capabilityIds = catalog.capabilities
    .filter((entry) => entry.availability.state === 'available' && claimsDevice(entry))
    .map((entry) => entry.id);
  return capabilityIds.length ? { sourceSlotId: run.slotId, capabilityIds } : undefined;
}

export async function slotCapabilityCatalogs(
  slotIds: readonly string[],
  capabilityIds: readonly string[] | undefined,
): Promise<SlotCapabilityCatalogs | undefined> {
  if (!capabilityIds?.length) return undefined;
  return new Map(
    await Promise.all(
      [...new Set(slotIds)].map(async (slotId) => {
        const catalog = await listSlotCapabilities(slotId);
        return [slotId, catalog.capabilities] as const;
      }),
    ),
  );
}

/** Configured capability availability is eligibility, not a scoring penalty. */
export function slotCapabilityBlocker(
  slotId: string,
  requiredCapabilities?: readonly string[],
  catalogs?: SlotCapabilityCatalogs,
): string | null {
  for (const id of requiredCapabilities ?? []) {
    const entry = catalogs?.get(slotId)?.find((candidate) => candidate.id === id);
    if (!entry || entry.availability.state !== 'available')
      return `Required runtime capability '${id}' is unavailable: ${
        entry?.availability.reason ?? 'slot does not provide this capability'
      }`;
  }
  return null;
}
