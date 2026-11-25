import { isEvalRun, type Run } from '@farmslot/protocol';

import type { RawProjectJson } from '../core/index.js';
import { usesEvalTrialCapsule } from '../evals/trial-policy.js';

/** Every refusal of `skipPrepare` for a pinned run says this. */
export const PINNED_SKIP_PREPARE_REFUSAL =
  'A pinned comparison run cannot skip prepare; prepare installs the build of its start commit.';

/**
 * A project takes part in pinned prepare when it can install a build of a given
 * commit (it declares an `artifact_check` probe) or says how (`pinned_profiles`).
 * Its comparison runs with a start commit are then pinned; other projects prepare
 * them as before.
 */
export function projectPinsPrepare(projectJson: RawProjectJson): boolean {
  return (
    Boolean(projectJson.hooks?.artifact_check) || projectJson.prepare?.pinned_profiles !== undefined
  );
}

export type PinnedRunFields = Pick<Run, 'lane' | 'startRef' | 'flowType' | 'engineState'>;

/**
 * A run whose prepare must install a build of its start commit: a comparison-lane
 * dev or fix-bug run with a start ref (start-ref-policy.ts limits a user start ref
 * to these flows). Blind capsule trials keep their own isolated base, so they are
 * excluded; QA proof trials, comparison-lane QA runs, are excluded by flow. Both
 * record the build they ran on instead (`prepareObservesBuild`).
 */
export function isPinnedPrepareRun(run: PinnedRunFields): boolean {
  return (
    isEvalRun(run) &&
    Boolean(run.startRef) &&
    (run.flowType === 'dev' || run.flowType === 'fix-bug') &&
    !usesEvalTrialCapsule(run.engineState?.evalExperiment?.blind)
  );
}

/**
 * Whether this run's prepare is pinned: the run qualifies and its project takes
 * part. An unreadable project config (`undefined`) counts as taking part, so the
 * prepare refuses instead of running on whatever build the slot has.
 */
export function prepareIsPinned(
  run: PinnedRunFields,
  projectJson: RawProjectJson | undefined,
): boolean {
  return isPinnedPrepareRun(run) && (projectJson ? projectPinsPrepare(projectJson) : true);
}
