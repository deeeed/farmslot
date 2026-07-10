import type { DispatchPreviewParams, FlowType, Run } from '@farmslot/protocol';

import { normalizeRunner, runnerDefaultModel } from '../runners/registry.js';

export function buildDispatchPreviewParamsForRun(
  run: Pick<
    Run,
    | 'project'
    | 'flowType'
    | 'ticketOrPr'
    | 'familyId'
    | 'lane'
    | 'variant'
    | 'slotId'
    | 'allowedSlots'
    | 'branch'
    | 'prepareProfile'
    | 'app'
  >,
): DispatchPreviewParams {
  // For PR-bound flows the run's branch IS the PR head, so pass it as
  // targetBranch so findBestSlot's score flips the stale penalty into a
  // bonus for slots already on that branch (matches dispatch.candidates).
  const targetBranch =
    (run.flowType === 'review-pr' || run.flowType === 'pr-complete') && run.branch
      ? run.branch
      : undefined;
  return {
    project: run.project,
    flowType: run.flowType,
    ticketOrPr: run.ticketOrPr,
    familyId: run.familyId,
    lane: run.lane,
    variant: run.variant ?? null,
    slotId: run.slotId || undefined,
    app: run.app || undefined,
    prepareProfile: run.prepareProfile || undefined,
    allowedSlots: run.allowedSlots && run.allowedSlots.length > 0 ? run.allowedSlots : undefined,
    targetBranch,
  };
}
export function determineSelectionMethodForRun(
  run: Pick<Run, 'flowType'>,
  requestedSlotId: string | undefined,
  projectSlots: Array<Pick<Run, never> & { lifecycle: string; slot: string }>,
  slotId: string,
): 'user-specified' | 'affinity' | 'scored' {
  if (requestedSlotId) return 'user-specified';
  return (run.flowType === 'pr-complete' || run.flowType === 'review-pr') &&
    projectSlots.some((s) => s.lifecycle === 'held' && s.slot === slotId)
    ? 'affinity'
    : 'scored';
}
export function resolveRunDispatchRunnerModel(
  run: Pick<Run, 'metrics'>,
  preview: { runner: string; model: string },
): { runner: string; model: string } {
  const explicitRunner = run.metrics.runner ? normalizeRunner(run.metrics.runner) : null;
  const runner = explicitRunner ?? normalizeRunner(preview.runner);
  const explicitModel =
    run.metrics.model && run.metrics.model !== 'unknown' ? run.metrics.model : null;
  const previewModel = preview.model && preview.model !== 'unknown' ? preview.model : null;
  const model =
    explicitModel ||
    (explicitRunner ? runnerDefaultModel(runner) : null) ||
    previewModel ||
    runnerDefaultModel(runner) ||
    'unknown';
  return { runner, model };
}
export function resolveCIWatchChainFlowType(dispatchAction?: string | null): FlowType | null {
  if (dispatchAction === 'dispatch-merge-main') return 'merge-main';
  if (dispatchAction === 'dispatch-pr-complete') return 'pr-complete';
  return null;
}
export function resolveCIWatchTerminalPatch(outcome?: {
  result?: 'passed' | 'failed' | 'blocked' | 'comments' | 'aborted' | 'timeout';
}): Partial<Run> | null {
  if (!outcome) return null;
  if (outcome.result === 'blocked') {
    return {
      status: 'blocked',
      metrics: {
        outcome: 'partial',
      } as Run['metrics'],
    };
  }
  if (outcome.result === 'failed') {
    return {
      metrics: {
        outcome: 'failure',
      } as Run['metrics'],
    };
  }
  if (outcome.result === 'comments') {
    return {
      metrics: {
        outcome: 'success',
      } as Run['metrics'],
    };
  }
  return null;
}
