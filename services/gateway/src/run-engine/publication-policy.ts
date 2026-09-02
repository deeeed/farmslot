import type { ProjectConfig, ReviewDepthPolicy, Run } from '@farmslot/protocol';

import type { RawProjectJson } from '../core/config.js';
import { isNoCodeTerminalDisposition } from '../tasks/worker-signals.js';

type PublicationReviewConfigSource = ProjectConfig | RawProjectJson | null | undefined;
type LocalFirstRunInput = Pick<
  Run,
  'flowType' | 'mode' | 'completionPolicy' | 'devInteractiveProfile' | 'engineState' | 'metrics'
>;

function isReviewedInteractiveDevRun(
  run: Pick<Run, 'flowType' | 'mode' | 'devInteractiveProfile' | 'engineState'>,
): boolean {
  if (run.flowType !== 'dev' || run.mode !== 'interactive') return false;
  return (
    run.devInteractiveProfile === 'reviewed' ||
    run.engineState?.interactiveDev?.profile === 'reviewed'
  );
}

function isLocalFirstPublicationCandidate(
  run: Pick<Run, 'flowType' | 'mode' | 'devInteractiveProfile' | 'engineState'>,
): boolean {
  return (
    run.flowType === 'fix-bug' ||
    (run.flowType === 'dev' && run.mode === 'autonomous') ||
    isReviewedInteractiveDevRun(run)
  );
}

function localFirstPublicationApplies(run: LocalFirstRunInput): boolean {
  if (!isLocalFirstPublicationCandidate(run)) return false;
  if (run.completionPolicy === 'artifact-only') return false;
  if (isNoCodeTerminalDisposition(run.metrics.disposition)) return false;
  return true;
}

export function shouldPrepareLocalFirstPackage(run: LocalFirstRunInput): boolean {
  return localFirstPublicationApplies(run);
}

// Phase-specific adapters are the public contract for completion, human-gate,
// and CI call sites. Keep the raw candidate predicate private so callers cannot
// skip artifact-only/no-code guards by accident.
export function requiresPublicationApproval(run: LocalFirstRunInput): boolean {
  return localFirstPublicationApplies(run);
}

export function ciRequiresPublishedPr(run: LocalFirstRunInput): boolean {
  return localFirstPublicationApplies(run);
}

function clampReviewPolicy(policy: ReviewDepthPolicy): ReviewDepthPolicy {
  const requireCrossRunner = policy.requireCrossRunner === true;
  return {
    minimumIndependentReviews: Math.max(
      requireCrossRunner ? 1 : 0,
      Math.max(0, policy.minimumIndependentReviews),
    ),
    requireCrossRunner,
    extraLoopsRequested: Math.max(0, policy.extraLoopsRequested),
    ...(policy.countingVersion === 2 ? { countingVersion: 2 as const } : {}),
    requestedBy: policy.requestedBy,
  };
}

function readConfiguredPolicy(
  projectConfig: PublicationReviewConfigSource,
  flowType: 'fix-bug' | 'dev',
): Partial<ReviewDepthPolicy> | null {
  if (!projectConfig) return null;
  const normalized =
    'publicationReview' in projectConfig ? projectConfig.publicationReview?.[flowType] : undefined;
  if (normalized) {
    return {
      minimumIndependentReviews: normalized.minimumIndependentReviews,
      requireCrossRunner: normalized.requireCrossRunner,
    };
  }
  const raw =
    'publication_review' in projectConfig
      ? projectConfig.publication_review?.[flowType]
      : undefined;
  if (raw) {
    return {
      minimumIndependentReviews: raw.minimum_independent_reviews,
      requireCrossRunner: raw.require_cross_runner,
    };
  }
  return null;
}

export function publicationReviewPolicyForRun(
  run: Pick<Run, 'flowType' | 'mode'>,
  projectConfig?: PublicationReviewConfigSource,
  requestedPolicy?: ReviewDepthPolicy | null,
): ReviewDepthPolicy {
  if (requestedPolicy) return clampReviewPolicy(requestedPolicy);
  const flowType = run.flowType === 'dev' ? 'dev' : run.flowType === 'fix-bug' ? 'fix-bug' : null;
  const defaultMinimum = flowType === 'dev' ? 0 : 1;
  const configured = flowType ? readConfiguredPolicy(projectConfig, flowType) : null;
  return clampReviewPolicy({
    minimumIndependentReviews: configured?.minimumIndependentReviews ?? defaultMinimum,
    requireCrossRunner: configured?.requireCrossRunner === true,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch',
  });
}
