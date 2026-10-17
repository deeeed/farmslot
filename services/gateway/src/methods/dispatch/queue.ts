import {
  type DispatchQueueAddParams,
  type DispatchQueueAddResult,
  type DispatchQueueListResult,
  type DispatchQueueRemoveOrphanParams,
  type DispatchQueueRemoveOrphanResult,
  type DispatchQueueRemoveParams,
  type DispatchQueueRemoveResult,
  type DispatchQueueReorderParams,
  type DispatchQueueReorderResult,
  type DispatchQueueUpdateParams,
  type DispatchQueueUpdateResult,
} from '@farmslot/protocol';
import {
  assertReviewPolicy,
  assertReviewSequence,
  assertWarmReviewContext,
  parseReviewRequestContext,
} from '@farmslot/review-dispatch';

import {
  addItem,
  listItems,
  queueRecordOriginator,
  recheckRepairedReviewPlan,
  removeItem,
  reorderItems,
  updateItem,
} from '../../backlog/dispatch-queue.js';
import { removeOrphanBacklogQueueItem } from '../../backlog/store.js';
import { normalizeRawStaticReview } from '../../core/config.js';
import { loadProjectVars, loadSlotVars } from '../../core/index.js';
import {
  assertReviewWorkspacePlacement,
  inspectReviewWorkspaceTarget,
} from '../../review-workspaces/admission.js';
import { resolveDirectWorkflowDefaults } from '../../review-workspaces/direct-defaults.js';
import { resolveStaticReviewOwner } from '../../security/native-worker-owner.js';
import { currentSessionOriginator, workAuthorshipNotice } from '../../security/work-originator.js';
import { captureRunCreationRequest } from '../../sources/creation-request.js';
import { sourceAuthority, withSourceRequestPlanning } from '../../sources/runtime.js';
import {
  projectUsesExecutionTemplateCatalog,
  resolveConfiguredExecutionTemplateForSlot,
} from '../../tasks/execution-template-catalog.js';
import { resolveWorkerTemplateSelection } from '../../tasks/worker-template-options.js';

import { normalizeTicketRef, resolvePrRef, validateTicketRef } from './ticket-ref.js';

// ─── Queue Handlers ───

// Store broadcasts QUEUE_UPDATED to all clients internally

export async function dispatchQueueAdd(
  params: DispatchQueueAddParams,
  sourcePlanningReady = false,
  authorizeSourceSelections?: () => void,
): Promise<DispatchQueueAddResult> {
  if ((sourceAuthority() || params.sourceSelections !== undefined) && !sourcePlanningReady)
    return withSourceRequestPlanning(
      { ...params, mode: params.mode === 'validation' ? 'autonomous' : params.mode },
      'queue',
      () => dispatchQueueAdd(params, true, authorizeSourceSelections),
    );
  const rawParams = params as DispatchQueueAddParams & {
    prWork?: unknown;
    backlogItemId?: unknown;
    workGraphId?: unknown;
    workNodeId?: unknown;
    launchPlanId?: unknown;
    launchCandidateId?: unknown;
    launchGroupId?: unknown;
    launchSlotPolicy?: unknown;
    ticketData?: unknown;
    workflowExecution?: unknown;
    reviewQaContract?: unknown;
  };
  if (
    rawParams.prWork !== undefined ||
    rawParams.backlogItemId !== undefined ||
    rawParams.workGraphId !== undefined ||
    rawParams.workNodeId !== undefined ||
    rawParams.launchPlanId !== undefined ||
    rawParams.launchCandidateId !== undefined ||
    rawParams.launchGroupId !== undefined ||
    rawParams.launchSlotPolicy !== undefined ||
    rawParams.ticketData !== undefined ||
    rawParams.workflowExecution !== undefined ||
    rawParams.reviewQaContract !== undefined
  ) {
    throw new Error(
      'dispatch.queue.add cannot accept backlog handoff metadata; use backlog.enqueue',
    );
  }
  if ('delegatedOwnerPrincipalId' in params)
    throw new Error('Static review delegation is gateway-owned');
  if (params.reviewSequence) assertReviewSequence(params.reviewSequence, { maxRows: 5 });
  if (params.reviewPolicy) assertReviewPolicy(params.reviewPolicy);
  if (params.reviewSequenceContext)
    parseReviewRequestContext(params.reviewSequenceContext, params.reviewSequence?.length ?? 0);
  if (params.reviewContext) parseReviewRequestContext(params.reviewContext, 1);
  if (params.reviewSequence)
    assertWarmReviewContext(params.reviewSequence, params.reviewSequenceContext);
  const projectVars = await loadProjectVars(params.project);
  if (params.flowType === 'review-pr') {
    const repo = projectVars.projectJson.ci?.repo;
    params = { ...params, ticketOrPr: normalizeTicketRef(params.ticketOrPr) };
    if (repo) params.ticketOrPr = await resolvePrRef(params.ticketOrPr, repo);
    validateTicketRef(params.ticketOrPr, 'review-pr');
  }
  const staticReviewOwner =
    params.flowType === 'review-pr' && params.reviewValidationDepth !== 'full-live'
      ? resolveStaticReviewOwner('live')
      : undefined;
  const workflowDefaults = await resolveDirectWorkflowDefaults(
    params,
    {
      workflowDefaults: projectVars.projectJson.workflow_defaults,
      qa: projectVars.projectJson.qa,
      staticReview: normalizeRawStaticReview(
        projectVars.projectJson.static_review,
        projectVars.projectConfig,
        projectVars.projectJson.reference_repos,
      ),
    },
    {
      purpose: 'queue',
      ...(staticReviewOwner ? { ownerId: staticReviewOwner.ownerId } : {}),
    },
  );
  params = workflowDefaults.params;
  const configuredCatalog = projectUsesExecutionTemplateCatalog(projectVars);
  assertReviewWorkspacePlacement(params);
  const workspaceAdmission = params.reviewWorkspaceTarget
    ? (workflowDefaults.admission ??
      (await inspectReviewWorkspaceTarget(
        {
          project: params.project,
          machine: params.reviewWorkspaceTarget.machine,
          runner: params.runner ?? '',
          model: params.model ?? '',
          effort: params.effort,
          transport: params.transport,
          nativeProfile: params.nativeProfile,
        },
        staticReviewOwner?.ownerId ?? resolveStaticReviewOwner('live').ownerId,
      )))
    : undefined;
  if (workspaceAdmission) {
    params.executionTemplateId = workspaceAdmission.project.staticReview!.templateId;
    params.completionPolicy = 'artifact-only';
    params.mode ??= 'autonomous';
  }
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
    // A pool candidate supplies template context without becoming an explicit slot pin.
    const templateSlotId =
      params.slotId ?? (params.flowType === 'qa' ? params.allowedSlots?.[0] : undefined);
    if ((!templateSlotId && !workspaceAdmission) || !params.mode) {
      throw new Error(
        'Queued execution-template selection requires both slotId and mode so the gateway can validate and snapshot it.',
      );
    }
    const slotVars = templateSlotId ? await loadSlotVars(templateSlotId) : undefined;
    executionTemplate = resolveConfiguredExecutionTemplateForSlot(projectVars, {
      flow: params.flowType,
      platform: slotVars?.platform ?? workspaceAdmission!.pool.platform,
      runMode: params.mode,
      ...(params.domain ? { explicitDomain: params.domain } : {}),
      ...(slotVars?.domain ? { slotDomain: slotVars.domain } : {}),
      ...(params.executionTemplateId ? { explicitId: params.executionTemplateId } : {}),
    }).reference;
  }
  authorizeSourceSelections?.();
  const item = addItem(
    {
      ...params,
      ...(workflowDefaults.execution ? { workflowExecution: workflowDefaults.execution } : {}),
      ...(workflowDefaults.reviewQa
        ? { reviewQaContract: workflowDefaults.reviewQa.contract }
        : {}),
      ...(normalizedTaskTemplate ? { taskTemplate: normalizedTaskTemplate } : {}),
      ...(executionTemplate ? { executionTemplate: { ...executionTemplate } } : {}),
    },
    currentSessionOriginator(),
    staticReviewOwner?.requester ? { delegatedOwnerPrincipalId: staticReviewOwner.ownerId } : {},
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

export async function dispatchQueueUpdate(
  params: DispatchQueueUpdateParams,
  authorizeSourceSelections?: () => void,
): Promise<DispatchQueueUpdateResult> {
  const previous = queueRecordOriginator(params.itemId);
  const originator = currentSessionOriginator();
  const original = listItems().find((item) => item.id === params.itemId);
  const publish = async (): Promise<DispatchQueueUpdateResult> => {
    authorizeSourceSelections?.();
    const current = listItems().find((item) => item.id === params.itemId);
    if (original && JSON.stringify(current) !== JSON.stringify(original))
      throw new Error('Queue item changed while validating source selections');
    const item = updateItem(params, originator);
    if (params.reviewSequence !== undefined) await recheckRepairedReviewPlan();
    const authorshipNotice = workAuthorshipNotice(previous, originator);
    return { item, ...(authorshipNotice ? { authorshipNotice } : {}) };
  };
  if (params.sourceSelections !== undefined && original) {
    return withSourceRequestPlanning(
      captureRunCreationRequest({
        ...original,
        sourceSelections: params.sourceSelections,
        slotId: params.slotId ?? original.slotId,
        allowedSlots: params.allowedSlots ?? original.allowedSlots ?? undefined,
        parentRunId: original.parentRunId ?? undefined,
        branch: original.branch ?? undefined,
        mode: original.mode === 'validation' ? 'autonomous' : original.mode,
        startRef: original.startRef?.requestedRef,
        startRefSource: original.startRef?.source,
      }),
      'queue',
      publish,
    );
  }
  return publish();
}

export function dispatchQueueReorder(
  params: DispatchQueueReorderParams,
): DispatchQueueReorderResult {
  return { items: reorderItems(params.itemIds, currentSessionOriginator()) };
}
