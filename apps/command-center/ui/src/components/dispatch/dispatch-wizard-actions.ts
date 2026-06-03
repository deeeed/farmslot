import type {
  DevInteractiveProfile,
  FlowType,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  Run,
  TaskTemplateSelection,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

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
  skipPrepare: boolean;
  nudgeIntent: 'nudge' | 'fresh' | undefined;
  mode: 'interactive' | 'autonomous';
  devInteractiveProfile: DevInteractiveProfile;
  reviewTier: '' | 'light' | 'standard' | 'full';
  reviewDepth?: ReviewDepthPolicy;
  pendingReviewPlan?: ReviewLoopRequest[];
  comparison: Partial<ComparisonRunParams>;
}

export function buildDispatchWizardPayloadDraft(
  input: DispatchPayloadDraftInput,
): DispatchPayloadDraft | null {
  if (!input.flowType) return null;
  return {
    flowType: input.flowType,
    project: input.project,
    ticketOrPr: input.ticketId,
    slotId: input.slotOverride || undefined,
    allowedSlots: input.allowedSlots,
    branch: input.branch,
    model: input.model || undefined,
    runner: input.runner || undefined,
    effort: input.effort || undefined,
    app: input.app,
    taskTemplate: input.taskTemplate,
    skipPrepare: input.skipPrepare || undefined,
    nudgeReuse: input.nudgeIntent === 'nudge' ? true : undefined,
    freshReuse: input.nudgeIntent === 'fresh' ? true : undefined,
    mode: input.mode,
    devInteractiveProfile: input.devInteractiveProfile,
    reviewTier: input.reviewTier || undefined,
    reviewDepth: input.reviewDepth,
    pendingReviewPlan: input.pendingReviewPlan,
    comparison: input.comparison,
  };
}

export async function dispatchRunCreateFromDraft(draft: DispatchPayloadDraft): Promise<string> {
  const result = await gateway.request<{ run: Run }>(
    Methods.RUN_CREATE,
    buildRunCreateParams(draft),
  );
  return result.run.id;
}

export async function addDispatchQueueItemFromDraft(draft: DispatchPayloadDraft): Promise<void> {
  await gateway.request(Methods.DISPATCH_QUEUE_ADD, buildDispatchQueueAddParams(draft));
}
