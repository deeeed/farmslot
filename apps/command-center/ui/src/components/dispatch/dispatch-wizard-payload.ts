import type {
  DevInteractiveProfile,
  DispatchCandidatesParams,
  DispatchQueueAddParams,
  FlowType,
  NativeProfileReference,
  PressureAdmissionReference,
  PressureDispatchOverride,
  QaInput,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  ReviewScope,
  ReviewWorkspaceTarget,
  RunCreateParams,
  TaskTemplateSelection,
} from '@farmslot/protocol';

export type ComparisonRunParams = Pick<
  RunCreateParams & DispatchQueueAddParams,
  'lane' | 'familyId' | 'variant' | 'parentRunId'
>;

export interface DispatchPayloadDraft {
  transport?: 'tmux' | 'native';
  nativeProfile?: NativeProfileReference;
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
  reviewWorkspaceTarget?: ReviewWorkspaceTarget;
  reviewAutoFinish?: boolean;
  publishReview?: boolean;
  qaProfileId?: string;
  qaInputs?: Record<string, QaInput>;
  slotId?: string;
  allowedSlots?: string[];
  branch?: string;
  mode: 'interactive' | 'autonomous';
  devInteractiveProfile: DevInteractiveProfile;
  skipPrepare?: boolean;
  prepareProfile?: string;
  reviewTier?: string;
  reviewScope?: ReviewScope;
  nudgeReuse?: boolean;
  freshReuse?: boolean;
  reviewDepth?: ReviewDepthPolicy;
  pendingReviewPlan?: ReviewLoopRequest[];
  /** Backend-rendered preview identity forwarded so execution can reject a
   * stale generation. Never computed client-side. */
  pressureAdmissionRef?: PressureAdmissionReference;
  /** Deliberate one-dispatch override bound to the rendered decision. */
  pressureOverride?: PressureDispatchOverride;
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
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.transport === 'native' && input.nativeProfile
      ? { nativeProfile: input.nativeProfile }
      : {}),
    flowType: input.flowType,
    project: input.project,
    ticketOrPr: input.ticketOrPr,
    reviewWorkspaceTarget: input.reviewWorkspaceTarget,
    qaProfileId: input.qaProfileId,
    qaInputs: input.qaInputs,
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
    reviewScope: input.reviewScope,
    reviewAutoFinish: input.flowType === 'review-pr' ? input.reviewAutoFinish : undefined,
    publishReview: input.flowType === 'review-pr' ? input.publishReview : undefined,
    reviewDepth: input.reviewDepth,
    pendingReviewPlan: input.pendingReviewPlan,
    pressureAdmissionRef: input.pressureAdmissionRef,
    pressureOverride: input.pressureOverride,
    ...input.comparison,
  };
}

export function buildDispatchQueueAddParams(input: DispatchPayloadDraft): DispatchQueueAddParams {
  return {
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.transport === 'native' && input.nativeProfile
      ? { nativeProfile: input.nativeProfile }
      : {}),
    ...(input.skipPrepare !== undefined ? { skipPrepare: input.skipPrepare } : {}),
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
    reviewWorkspaceTarget: input.reviewWorkspaceTarget,
    qaProfileId: input.qaProfileId,
    qaInputs: input.qaInputs,
    slotId: input.slotId,
    allowedSlots: input.allowedSlots,
    branch: input.branch,
    mode: input.mode,
    ...devInteractiveFields(input),
    reviewScope: input.reviewScope,
    reviewAutoFinish: input.flowType === 'review-pr' ? input.reviewAutoFinish : undefined,
    publishReview: input.flowType === 'review-pr' ? input.publishReview : undefined,
    reviewDepth: input.reviewDepth,
    pendingReviewPlan: input.pendingReviewPlan,
    ...input.comparison,
  };
}

export interface DispatchCandidatesDraft {
  project?: string;
  flowType: FlowType | undefined;
  machines: readonly string[];
  targetBranch: string | undefined;
  ticketOrPr: string | undefined;
  app: string | undefined;
  prepareProfile: string | undefined;
  /** Skip Prepare keeps each slot's checkout, so a slot whose repo cannot prepare stays eligible. */
  skipPrepare: boolean;
  comparison:
    | {
        familyId: string;
        variant: string;
      }
    | undefined;
  forceRefresh?: boolean;
}

export function buildDispatchCandidatesParams(
  input: DispatchCandidatesDraft,
): DispatchCandidatesParams {
  return {
    ...(input.project ? { project: input.project } : {}),
    flowType: input.flowType,
    machines: input.machines.length > 0 ? [...input.machines] : undefined,
    targetBranch: input.targetBranch,
    // Forward PR / lane context so the gateway can populate `nudgeEligible` + `nudgeMeta`
    // on busy slots already loaded on this PR's branch. Without ticketOrPr the server
    // can't run the branch/PR-number match in collectBranchAffinityNudgeCandidates and
    // the wizard sees free-slot rows only — no REUSE WORKER affordance.
    ticketOrPr: input.ticketOrPr,
    // Forward app/profile so candidate rows reflect companion-resource eligibility —
    // otherwise a resource-ineligible busy slot advertises reuse that FIND_SLOT rejects.
    app: input.app,
    prepareProfile: input.prepareProfile,
    ...(input.skipPrepare ? { skipPrepare: true } : {}),
    ...(input.forceRefresh ? { forceRefresh: true } : {}),
    ...(input.comparison
      ? {
          lane: 'comparison' as const,
          familyId: input.comparison.familyId,
          variant: input.comparison.variant,
        }
      : {}),
  };
}
