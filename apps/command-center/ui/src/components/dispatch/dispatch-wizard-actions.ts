import type {
  DevInteractiveProfile,
  FlowType,
  NativeProfileReference,
  PressureAdmissionReference,
  PressureDispatchOverride,
  QaInput,
  ReviewDepthPolicy,
  ReviewLoopRequest,
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
  transport?: 'tmux' | 'native';
  nativeProfile?: NativeProfileReference;
  flowType: FlowType | null;
  project: string;
  ticketId: string;
  reviewMachine?: string;
  reviewAutoFinish?: boolean;
  publishReview?: boolean;
  qaProfileId?: string;
  qaInputs?: Record<string, QaInput>;
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
  reviewTier?: '' | 'light' | 'standard' | 'full';
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
  const workspace = input.flowType === 'review-pr';
  const variant = input.comparison.variant?.trim() ?? '';
  const branch = resolveComparisonDispatchBranch({
    comparisonLane: Boolean(input.comparison.lane === 'comparison'),
    variant,
    branch: input.branch,
  });
  return {
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.transport === 'native' && input.nativeProfile
      ? { nativeProfile: input.nativeProfile }
      : {}),
    flowType: input.flowType,
    project: input.project,
    ticketOrPr: input.ticketId,
    ...(workspace && input.reviewMachine
      ? { reviewWorkspaceTarget: { machine: input.reviewMachine } }
      : {}),
    ...(input.flowType === 'qa'
      ? { qaProfileId: input.qaProfileId, qaInputs: input.qaInputs }
      : {}),
    slotId: workspace ? undefined : input.slotOverride || undefined,
    allowedSlots: workspace ? undefined : input.allowedSlots,
    branch,
    model: input.model || undefined,
    runner: input.runner || undefined,
    effort: input.effort || undefined,
    app: input.app,
    taskTemplate: input.taskTemplate,
    domain: input.domain,
    executionTemplateId: input.executionTemplateId,
    skipPrepare: workspace ? undefined : input.skipPrepare || undefined,
    prepareProfile: workspace ? undefined : input.prepareProfile || undefined,
    nudgeReuse: !workspace && input.nudgeIntent === 'nudge' ? true : undefined,
    freshReuse: !workspace && input.nudgeIntent === 'fresh' ? true : undefined,
    mode: input.mode,
    devInteractiveProfile: input.devInteractiveProfile,
    reviewTier: input.reviewTier || undefined,
    reviewAutoFinish: input.flowType === 'review-pr' ? input.reviewAutoFinish : undefined,
    publishReview: input.flowType === 'review-pr' ? input.publishReview : undefined,
    reviewScope: input.flowType === 'review-pr' ? 'full' : undefined,
    reviewDepth: input.reviewDepth,
    pendingReviewPlan: input.pendingReviewPlan,
    pressureAdmissionRef: workspace ? undefined : input.pressureAdmissionRef,
    pressureOverride: workspace ? undefined : input.pressureOverride,
    comparison: input.comparison,
  };
}

export async function dispatchRunCreateFromDraft(draft: DispatchPayloadDraft): Promise<string> {
  const result = await gateway.request<RunCreateResult>(
    draft.transport === 'native' ? Methods.RUN_CREATE_NATIVE : Methods.RUN_CREATE,
    buildRunCreateParams(draft),
  );
  return result.run.id;
}

export async function addDispatchQueueItemFromDraft(draft: DispatchPayloadDraft): Promise<void> {
  await gateway.request(Methods.DISPATCH_QUEUE_ADD, buildDispatchQueueAddParams(draft));
}
