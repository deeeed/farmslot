import type {
  DispatchQueueAddParams,
  DispatchQueueAddResult,
  DispatchQueueListResult,
  DispatchQueueRemoveOrphanParams,
  DispatchQueueRemoveOrphanResult,
  DispatchQueueRemoveParams,
  DispatchQueueRemoveResult,
  DispatchQueueReorderParams,
  DispatchQueueReorderResult,
  DispatchQueueUpdateParams,
  DispatchQueueUpdateResult,
} from '@farmslot/protocol';

import {
  addItem,
  listItems,
  removeItem,
  reorderItems,
  updateItem,
} from '../../backlog/dispatch-queue.js';
import { removeOrphanBacklogQueueItem } from '../../backlog/store.js';
import { loadProjectVars } from '../../core/index.js';
import { resolveWorkerTemplateSelection } from '../../tasks/worker-template-options.js';

// ─── Queue Handlers ───

// Store broadcasts QUEUE_UPDATED to all clients internally

export async function dispatchQueueAdd(
  params: DispatchQueueAddParams,
): Promise<DispatchQueueAddResult> {
  const rawParams = params as DispatchQueueAddParams & {
    backlogItemId?: unknown;
    workGraphId?: unknown;
    workNodeId?: unknown;
    launchPlanId?: unknown;
    launchCandidateId?: unknown;
    launchGroupId?: unknown;
    launchSlotPolicy?: unknown;
    ticketData?: unknown;
  };
  if (
    rawParams.backlogItemId !== undefined ||
    rawParams.workGraphId !== undefined ||
    rawParams.workNodeId !== undefined ||
    rawParams.launchPlanId !== undefined ||
    rawParams.launchCandidateId !== undefined ||
    rawParams.launchGroupId !== undefined ||
    rawParams.launchSlotPolicy !== undefined ||
    rawParams.ticketData !== undefined
  ) {
    throw new Error(
      'dispatch.queue.add cannot accept backlog handoff metadata; use backlog.enqueue',
    );
  }
  let normalizedTaskTemplate: DispatchQueueAddParams['taskTemplate'];
  if (params.taskTemplate) {
    const projectVars = await loadProjectVars(params.project);
    const selectedTemplate = await resolveWorkerTemplateSelection(
      projectVars,
      params.flowType,
      params.taskTemplate,
    );
    normalizedTaskTemplate = {
      fileName: selectedTemplate.fileName,
      variant: selectedTemplate.variant,
    };
  }
  const item = addItem(
    normalizedTaskTemplate ? { ...params, taskTemplate: normalizedTaskTemplate } : params,
  );
  return { item };
}

export function dispatchQueueList(): DispatchQueueListResult {
  return { items: listItems() };
}

export function dispatchQueueRemove(params: DispatchQueueRemoveParams): DispatchQueueRemoveResult {
  removeItem(params.itemId);
  return { ok: true };
}

export async function dispatchQueueRemoveOrphan(
  params: DispatchQueueRemoveOrphanParams,
): Promise<DispatchQueueRemoveOrphanResult> {
  return removeOrphanBacklogQueueItem(params);
}

export function dispatchQueueUpdate(params: DispatchQueueUpdateParams): DispatchQueueUpdateResult {
  return { item: updateItem(params) };
}

export function dispatchQueueReorder(
  params: DispatchQueueReorderParams,
): DispatchQueueReorderResult {
  return { items: reorderItems(params.itemIds) };
}
