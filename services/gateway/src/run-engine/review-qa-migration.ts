import { isDeepStrictEqual } from 'node:util';

import {
  type ProjectQaConfig,
  type ProjectWorkflowDefaults,
  resolvePRWorkflowDefaults,
  resolveReviewQaDispatch,
  ReviewQaConfigurationError,
  type Run,
  selectQaProfile,
} from '@farmslot/protocol';

/** Allocation may normalize legacy work or revalidate a QA snapshot; launched work is historical. */
export function canReconcileReviewQaRun(run: Run): boolean {
  return (
    ((run.flowType === 'review-pr' && !run.reviewQaContract) ||
      (run.flowType === 'qa' && !!run.reviewQaContract)) &&
    !run.reviewWorkspaceTarget &&
    !run.reviewWorkspace &&
    (run.status === 'created' || run.status === 'slot-finding') &&
    !run.metrics.runnerSessionId &&
    !run.metrics.runnerSessionPath &&
    !run.metrics.runnerSessionArchive &&
    !run.metrics.outcome &&
    !run.metrics.terminalEvidence &&
    !run.metrics.sessionTurns &&
    !run.metrics.nudgeCount &&
    !run.agentContexts?.some(
      (context) =>
        context.nativeSession ||
        context.nativeSessionHistory?.length ||
        context.runnerSessionId ||
        context.runnerSessionPath ||
        context.startedAt ||
        context.attemptStartedAt ||
        context.promptDeliveryStartedAt,
    ) &&
    run.steps.every(
      (step) =>
        step.status === 'pending' || (step.name === 'find-slot' && step.status === 'running'),
    )
  );
}

export function reviewQaMigrationPatch(
  run: Run,
  config?: ProjectQaConfig,
  workflowDefaults?: ProjectWorkflowDefaults,
): Partial<Run> | undefined {
  if (!canReconcileReviewQaRun(run)) return undefined;
  const defaults = resolvePRWorkflowDefaults({ workflow: 'qa', farm: workflowDefaults }).review;
  if (run.flowType === 'qa') {
    if (!run.qa)
      throw new ReviewQaConfigurationError('QA run lacks its admitted farm preset snapshot');
    const current = selectQaProfile(config, run.qa.profile.id, {
      ...defaults.qaInputs,
      ...run.qa.inputs,
    });
    if (!isDeepStrictEqual(current, run.qa))
      throw new ReviewQaConfigurationError(
        'QA preset changed after run admission; create a new QA run with the current preset',
      );
    return undefined;
  }
  const selected = resolveReviewQaDispatch(
    run.reviewValidationDepth === 'full-live'
      ? { ...run, qaProfileId: defaults.qaProfileId, qaInputs: defaults.qaInputs }
      : run,
    config,
  );
  if (!selected) return undefined;
  if (selected.flowType === 'review-pr') {
    throw new ReviewQaConfigurationError(
      'Legacy static review requires explicit workspace migration; no slot will be claimed',
    );
  }
  selected.contract.legacy = {
    ...selected.contract.legacy,
    ...(run.executionTemplate ? { executionTemplate: structuredClone(run.executionTemplate) } : {}),
    ...(run.taskFile ? { taskFile: run.taskFile } : {}),
  };
  return {
    flowType: 'qa',
    reviewQaContract: selected.contract,
    qa: selected.qa,
    executionTemplateId: selected.qa.profile.template_id,
    executionTemplate: undefined,
    taskTemplate: undefined,
    taskFile: null,
    activeTaskFile: undefined,
    agentContexts: undefined,
    completionPolicy: 'artifact-only',
    reviewTier: undefined,
    reviewValidationDepth: undefined,
  };
}
