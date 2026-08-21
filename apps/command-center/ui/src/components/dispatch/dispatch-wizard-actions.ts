import type {
  DevInteractiveProfile,
  FlowType,
  PressureAdmissionReference,
  PressureDispatchOverride,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  ReviewValidationDepth,
  RunCreateResult,
  TaskTemplateSelection,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import { resolveComparisonDispatchBranch } from './dispatch-wizard-comparison-state.js';
import {
  buildDispatchQueueAddParams,
  buildRunCreateParams,
  type ComparisonRunParams,
  type DispatchPayloadDraft,
} from './dispatch-wizard-payload.js';

export interface DispatchPayloadDraftInput {
  flowType: FlowType | null;
  project: string;
  ticketId: string;
  slotOverride: string;
  allowedSlots: string[] | undefined;
  branch: string | undefined;
  model: string;
  runner: string;
  effort: string;
  app: string | undefined;
  taskTemplate: TaskTemplateSelection | undefined;
  domain?: string;
  executionTemplateId?: string;
  skipPrepare: boolean;
  prepareProfile: string;
  nudgeIntent: 'nudge' | 'fresh' | undefined;
  mode: 'interactive' | 'autonomous';
  devInteractiveProfile: DevInteractiveProfile;
  reviewTier: '' | 'light' | 'standard' | 'full';
  reviewValidationDepth: ReviewValidationDepth;
  reviewDepth?: ReviewDepthPolicy;
  pendingReviewPlan?: ReviewLoopRequest[];
  pressureAdmissionRef?: PressureAdmissionReference;
  pressureOverride?: PressureDispatchOverride;
  comparison: Partial<ComparisonRunParams>;
}

export function buildDispatchWizardPayloadDraft(
  input: DispatchPayloadDraftInput,
): DispatchPayloadDraft | null {
  if (!input.flowType) return null;
  const variant = input.comparison.variant?.trim() ?? '';
  const branch = resolveComparisonDispatchBranch({
    comparisonLane: Boolean(input.comparison.lane === 'comparison'),
    variant,
    branch: input.branch,
  });
  return {
    flowType: input.flowType,
    project: input.project,
    ticketOrPr: input.ticketId,
    slotId: input.slotOverride || undefined,
    allowedSlots: input.allowedSlots,
    branch,
    model: input.model || undefined,
    runner: input.runner || undefined,
    effort: input.effort || undefined,
    app: input.app,
    taskTemplate: input.taskTemplate,
    domain: input.domain,
    executionTemplateId: input.executionTemplateId,
    skipPrepare: input.skipPrepare || undefined,
    prepareProfile: input.prepareProfile || undefined,
    nudgeReuse: input.nudgeIntent === 'nudge' ? true : undefined,
    freshReuse: input.nudgeIntent === 'fresh' ? true : undefined,
    mode: input.mode,
    devInteractiveProfile: input.devInteractiveProfile,
    reviewTier: input.reviewTier || undefined,
    reviewScope: input.flowType === 'review-pr' ? 'full' : undefined,
    reviewValidationDepth: input.flowType === 'review-pr' ? input.reviewValidationDepth : undefined,
    reviewDepth: input.reviewDepth,
    pendingReviewPlan: input.pendingReviewPlan,
    pressureAdmissionRef: input.pressureAdmissionRef,
    pressureOverride: input.pressureOverride,
    comparison: input.comparison,
  };
}

export async function dispatchRunCreateFromDraft(draft: DispatchPayloadDraft): Promise<string> {
  const result = await gateway.request<RunCreateResult>(
    Methods.RUN_CREATE,
    buildRunCreateParams(draft),
  );
  return result.run.id;
}

export async function addDispatchQueueItemFromDraft(draft: DispatchPayloadDraft): Promise<void> {
  await gateway.request(Methods.DISPATCH_QUEUE_ADD, buildDispatchQueueAddParams(draft));
}
