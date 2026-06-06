// methods/resource.ts — resource.list + resource.control + resource.health handlers

import type {
  ResourceControlParams,
  ResourceControlResult,
  ResourceHealthParams,
  ResourceHealthResult,
  ResourceListParams,
  ResourceListResult,
} from '@farmslot/protocol';

import {
  executeResourceControl,
  pollSlotResources,
  resolveSlotResources,
} from '../fleet/resource-manager.js';

export async function resourceList(params: ResourceListParams): Promise<ResourceListResult> {
  const resources = await resolveSlotResources(params.slotId);
  return { resources };
}

export async function resourceControl(
  params: ResourceControlParams,
): Promise<ResourceControlResult> {
  return executeResourceControl(params.slotId, params.resourceId, params.action);
}

export async function resourceHealth(params: ResourceHealthParams): Promise<ResourceHealthResult> {
  const results = await pollSlotResources(params.slotId, { probeInactiveSimulators: true });
  return { slotId: params.slotId, resources: results };
}
