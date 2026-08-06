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
  queueRecordOriginator,
  removeItem,
  reorderItems,
  updateItem,
} from '../../backlog/dispatch-queue.js';
import { removeOrphanBacklogQueueItem } from '../../backlog/store.js';
import { loadProjectVars, loadSlotVars } from '../../core/index.js';
import {
  projectUsesExecutionTemplateCatalog,
  resolveConfiguredExecutionTemplateForSlot,
} from '../../tasks/execution-template-catalog.js';
import { resolveWorkerTemplateSelection } from '../../tasks/worker-template-options.js';
import { currentSessionOriginator, workAuthorshipNotice } from '../../security/work-originator.js';

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
  const projectVars = await loadProjectVars(params.project);
  const configuredCatalog = projectUsesExecutionTemplateCatalog(projectVars);
  if (params.executionTemplateId && !configuredCatalog) {
    throw new Error(
      'executionTemplateId is only valid for a project with execution_templates configured.',
    );
  }
  let normalizedTaskTemplate: DispatchQueueAddParams['taskTemplate'];
  if (params.taskTemplate) {
    if (configuredCatalog) {
      throw new Error(
        'Configured execution-template projects require executionTemplateId, not taskTemplate.',
      );
    }
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
  let executionTemplate: import('@farmslot/protocol').ExecutionTemplateReference | undefined;
  if (configuredCatalog) {
    if (!params.slotId || !params.mode) {
      throw new Error(
        'Queued execution-template selection requires both slotId and mode so the gateway can validate and snapshot it.',
      );
    }
    const slotVars = await loadSlotVars(params.slotId);
    executionTemplate = resolveConfiguredExecutionTemplateForSlot(projectVars, {
      flow: params.flowType,
      platform: slotVars.platform,
      runMode: params.mode,
      ...(params.domain ? { explicitDomain: params.domain } : {}),
      ...(slotVars.domain ? { slotDomain: slotVars.domain } : {}),
      ...(params.executionTemplateId ? { explicitId: params.executionTemplateId } : {}),
    }).reference;
  }
  const item = addItem(
    {
      ...params,
      ...(normalizedTaskTemplate ? { taskTemplate: normalizedTaskTemplate } : {}),
      ...(executionTemplate ? { executionTemplate: { ...executionTemplate } } : {}),
    },
    currentSessionOriginator(),
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
  const previous = queueRecordOriginator(params.itemId);
  const originator = currentSessionOriginator();
  const item = updateItem(params, originator);
  const authorshipNotice = workAuthorshipNotice(previous, originator);
  return { item, ...(authorshipNotice ? { authorshipNotice } : {}) };
}

export function dispatchQueueReorder(
  params: DispatchQueueReorderParams,
): DispatchQueueReorderResult {
  return { items: reorderItems(params.itemIds, currentSessionOriginator()) };
}
