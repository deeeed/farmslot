import type { RunCreateParams } from '@farmslot/protocol';

// Compile-time completeness keeps new dispatch inputs in queued revalidation.
const REQUEST_FIELDS = {
  sourceSelections: true,
  qaProfileId: true,
  qaInputs: true,
  flowType: true,
  project: true,
  ticketOrPr: true,
  familyId: true,
  parentRunId: true,
  familyRootTicketOrPr: true,
  lane: true,
  variant: true,
  taskTemplate: true,
  executionTemplateId: true,
  reviewWorkspaceTarget: true,
  slotId: true,
  taskFile: true,
  branch: true,
  ticketData: true,
  engineState: true,
  completionPolicy: true,
  pipelineReview: true,
  startRef: true,
  startRefSource: true,
  prNumber: true,
  model: true,
  runner: true,
  transport: true,
  nativeProfile: true,
  scripted: true,
  effort: true,
  app: true,
  domain: true,
  mode: true,
  skipPrepare: true,
  startRefSkipPrepareVerified: true,
  prepareProfile: true,
  waitPolicy: true,
  branchUpdateStrategy: true,
  nudgeReuse: true,
  freshReuse: true,
  reviewTier: true,
  publishReview: true,
  reviewTeamId: true,
  reviewAutoFinish: true,
  reviewMode: true,
  reviewValidationDepth: true,
  reviewPolicy: true,
  reviewSequence: true,
  reviewContext: true,
  reviewSequenceContext: true,
  safetyTier: true,
  pressureOverride: true,
  pressureAdmissionRef: true,
  allowedSlots: true,
  requiredCapabilities: true,
  backlogItemId: true,
  workGraphId: true,
  workNodeId: true,
  launchPlanId: true,
  launchCandidateId: true,
  launchGroupId: true,
  launchSlotPolicy: true,
  launchAttempt: true,
  devInteractiveProfile: true,
  tags: true,
  initialContext: true,
  devChecklist: true,
} satisfies Record<keyof RunCreateParams, true>;

/** Retain caller choices without copying unknown wire fields or trusted verification flags. */
export function captureRunCreationRequest(params: RunCreateParams): RunCreateParams {
  const result: RunCreateParams = {
    flowType: params.flowType,
    project: params.project,
    ticketOrPr: params.ticketOrPr,
  };
  const copy = <Key extends keyof RunCreateParams>(key: Key): void => {
    if (key !== 'startRefSkipPrepareVerified' && params[key] !== undefined)
      result[key] = structuredClone(params[key]);
  };
  for (const key of Object.keys(REQUEST_FIELDS) as Array<keyof RunCreateParams>) copy(key);
  return result;
}
