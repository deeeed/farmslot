import type {
  DevInteractiveProfile,
  DispatchQueueAddParams,
  FlowType,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  RunCreateParams,
  TaskTemplateSelection,
} from '@farmslot/protocol';

export type ComparisonRunParams = Pick<
  RunCreateParams & DispatchQueueAddParams,
  'lane' | 'familyId' | 'variant' | 'parentRunId'
>;

export interface DispatchPayloadDraft {
  flowType: FlowType;
  project: string;
  ticketOrPr: string;
  app?: string;
  taskTemplate?: TaskTemplateSelection;
  domain?: string;
  executionTemplateId?: string;
  model?: string;
  runner?: string;
  effort?: string;
  slotId?: string;
  allowedSlots?: string[];
  branch?: string;
  mode: 'interactive' | 'autonomous';
  devInteractiveProfile: DevInteractiveProfile;
  skipPrepare?: boolean;
  prepareProfile?: string;
  reviewTier?: string;
  nudgeReuse?: boolean;
  freshReuse?: boolean;
  reviewDepth?: ReviewDepthPolicy;
  pendingReviewPlan?: ReviewLoopRequest[];
  comparison: Partial<ComparisonRunParams>;
}

function devInteractiveFields(
  input: DispatchPayloadDraft,
): Pick<RunCreateParams, 'devInteractiveProfile' | 'initialContext'> {
  if (input.flowType === 'dev' && input.mode === 'interactive') {
    return {
      devInteractiveProfile: input.devInteractiveProfile,
      initialContext: input.ticketOrPr.trim(),
    };
  }
  return {};
}

export function buildRunCreateParams(input: DispatchPayloadDraft): RunCreateParams {
  return {
    flowType: input.flowType,
    project: input.project,
    ticketOrPr: input.ticketOrPr,
    slotId: input.slotId,
    allowedSlots: input.allowedSlots,
    branch: input.branch,
    model: input.model,
    runner: input.runner,
    effort: input.effort,
    app: input.app,
    taskTemplate: input.taskTemplate,
    domain: input.domain,
    executionTemplateId: input.executionTemplateId,
    skipPrepare: input.skipPrepare,
    prepareProfile: input.skipPrepare ? undefined : input.prepareProfile,
    nudgeReuse: input.nudgeReuse,
    freshReuse: input.freshReuse,
    mode: input.mode,
    ...devInteractiveFields(input),
    reviewTier: input.reviewTier,
    reviewDepth: input.reviewDepth,
    pendingReviewPlan: input.pendingReviewPlan,
    ...input.comparison,
  };
}

export function buildDispatchQueueAddParams(input: DispatchPayloadDraft): DispatchQueueAddParams {
  return {
    flowType: input.flowType,
    project: input.project,
    ticketOrPr: input.ticketOrPr,
    app: input.app,
    prepareProfile: input.skipPrepare ? undefined : input.prepareProfile,
    taskTemplate: input.taskTemplate,
    domain: input.domain,
    executionTemplateId: input.executionTemplateId,
    model: input.model,
    runner: input.runner,
    effort: input.effort,
    slotId: input.slotId,
    allowedSlots: input.allowedSlots,
    branch: input.branch,
    mode: input.mode,
    ...devInteractiveFields(input),
    reviewDepth: input.reviewDepth,
    pendingReviewPlan: input.pendingReviewPlan,
    ...input.comparison,
  };
}
