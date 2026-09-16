import { isDeepStrictEqual } from 'node:util';

import {
  isPRWorkspaceExecutionProfile,
  type ProjectQaConfig,
  type ProjectWorkflowDefaults,
  type QueueItem,
  resolvePRWorkflowDefaults,
  resolveReviewQaDispatch,
  ReviewQaConfigurationError,
} from '@farmslot/protocol';

/** Normalize only unstarted work; preserve its durable identity and placement constraints. */
export function migrateQueuedReviewQa(
  item: QueueItem,
  qa?: ProjectQaConfig,
  workflowDefaults?: ProjectWorkflowDefaults,
): boolean {
  if (item.status !== 'queued' || item.runId || item.queueKind === 'eval-cell') return false;
  const runtime = item.flowType === 'qa' || item.reviewValidationDepth === 'full-live';
  const defaults = runtime
    ? resolvePRWorkflowDefaults({ workflow: 'qa', farm: workflowDefaults }).review
    : undefined;
  const selected = resolveReviewQaDispatch(
    runtime
      ? {
          ...item,
          qaProfileId: item.qaProfileId ?? defaults?.qaProfileId,
          qaInputs: { ...defaults?.qaInputs, ...item.qaInputs },
        }
      : item,
    qa,
  );
  if (!selected) return false;
  if (selected.flowType === 'qa') {
    if (
      item.reviewWorkspaceTarget ||
      (item.workflowExecution && isPRWorkspaceExecutionProfile(item.workflowExecution))
    )
      throw new ReviewQaConfigurationError(
        'QA requires an authorized runtime slot, not workspace placement',
      );
    if (item.reviewQaContract) {
      if (
        item.qaProfileId === undefined ||
        item.qaInputs === undefined ||
        item.executionTemplateId === undefined
      )
        throw new ReviewQaConfigurationError(
          'Queued QA lacks its admitted profile, inputs or template; requeue with an explicit selection',
        );
      if (!isDeepStrictEqual(item.qaInputs, selected.qa.inputs))
        throw new ReviewQaConfigurationError(
          'QA preset adds inputs after admission; review the changed preset and requeue',
        );
    }
  }
  const contract = structuredClone(item.reviewQaContract ?? selected.contract);
  const legacyLive =
    !item.reviewQaContract && item.flowType === 'review-pr' && selected.flowType === 'qa';
  if (legacyLive) {
    contract.legacy = {
      ...contract.legacy,
      ...(item.executionTemplateId ? { executionTemplateId: item.executionTemplateId } : {}),
      ...(item.executionTemplate
        ? { executionTemplate: structuredClone(item.executionTemplate) }
        : {}),
      ...(item.taskTemplate ? { taskTemplate: structuredClone(item.taskTemplate) } : {}),
    };
  }
  const changed =
    item.flowType !== selected.flowType ||
    !isDeepStrictEqual(item.reviewQaContract, contract) ||
    item.reviewTier !== undefined ||
    item.reviewValidationDepth !== undefined ||
    item.recipeStrategy !== undefined ||
    (selected.qa !== undefined &&
      (item.qaProfileId !== selected.qa.profile.id ||
        !isDeepStrictEqual(item.qaInputs, selected.qa.inputs) ||
        item.executionTemplateId !== selected.qa.profile.template_id));
  if (!changed) return false;
  item.flowType = selected.flowType;
  item.reviewQaContract = contract;
  if (selected.flowType === 'qa') {
    if (legacyLive) {
      delete item.executionTemplate;
      delete item.taskTemplate;
    }
    item.executionTemplateId = selected.qa.profile.template_id;
    item.qaProfileId = selected.qa.profile.id;
    item.qaInputs = structuredClone(selected.qa.inputs);
    item.completionPolicy = 'artifact-only';
  }
  delete item.reviewTier;
  delete item.reviewValidationDepth;
  delete item.recipeStrategy;
  return true;
}
