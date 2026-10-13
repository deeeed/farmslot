import type {
  Run,
  RunSlotCapabilityRequirements,
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityListResult,
} from '@farmslot/protocol';
import {
  isMissingProjectConfigError,
  SlotConfigError,
  withProjectSources,
} from '@farmslot/slot-config';

import { claimsDevice } from '../runtime-capabilities/device-target.js';
import type { SourceSlotPlans } from '../sources/slot-planning.js';

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
  let catalog: RuntimeCapabilityListResult;
  try {
    catalog = await list(run.slotId);
  } catch (error) {
    if (
      !(error instanceof SlotConfigError && error.code === 'SLOT_NOT_FOUND') &&
      !isMissingProjectConfigError(error)
    )
      throw error;
    // Historical runs may outlive their pool entry. No device requirement can
    // be inferred from a removed slot; retained snapshots above still apply.
    console.info(`[run] source slot ${run.slotId} was removed; no device intent inferred`);
    return undefined;
  }
  const capabilityIds = catalog.capabilities
    .filter((entry) => entry.availability.state === 'available' && claimsDevice(entry))
    .map((entry) => entry.id);
  return capabilityIds.length ? { sourceSlotId: run.slotId, capabilityIds } : undefined;
}

export async function slotCapabilityCatalogs(
  slotIds: readonly string[],
  capabilityIds: readonly string[] | undefined,
  plans?: SourceSlotPlans,
  list: (slotId: string) => Promise<RuntimeCapabilityListResult> = listSlotCapabilities,
): Promise<SlotCapabilityCatalogs | undefined> {
  if (!capabilityIds?.length) return undefined;
  return new Map<string, readonly RuntimeCapabilityCatalogEntry[]>(
    await Promise.all(
      [...new Set(slotIds)].map(async (slotId) => {
        const plan = plans?.get(slotId);
        if (plans && (!plan || 'refusal' in plan)) return [slotId, []] as const;
        const catalog =
          plan && 'sources' in plan
            ? await withProjectSources(plan.sources, () => list(slotId))
            : await list(slotId);
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
