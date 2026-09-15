import type {
  ProjectWorkflowDefaults,
  PRWorkflowDefaultSource,
  PRWorkflowDefaultSources,
  PRWorkflowPolicy,
} from '../contracts/config.js';
import type { PRExecutionProfile } from '../contracts/pr-monitoring.js';
import { DEFAULT_PR_REVIEW_OPTIONS, type PRReviewOptions } from '../contracts/pr-rules.js';
import type { ReviewValidationDepth } from '../contracts/runs.js';

import { assertPRExecutionProfile, isPRWorkspaceExecutionProfile } from './pr-monitoring.js';
import { assertPRReviewOptions } from './pr-rule-config.js';

export function assertProjectWorkflowDefaults(
  value: unknown,
): asserts value is ProjectWorkflowDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('workflow_defaults must be an object');
  for (const [flow, policy] of Object.entries(value)) {
    if (flow !== 'review-pr') throw new Error(`Unsupported workflow_defaults key: ${flow}`);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
      throw new Error(`workflow_defaults.${flow} must be an object`);
    if (
      !Object.keys(policy).length ||
      Object.keys(policy).some((key) => key !== 'execution' && key !== 'review')
    )
      throw new Error(`workflow_defaults.${flow} must contain execution or review only`);
    if (policy.execution !== undefined) {
      assertPRExecutionProfile(policy.execution);
      if (!isPRWorkspaceExecutionProfile(policy.execution))
        throw new Error('workflow_defaults.review-pr.execution requires workspace machines');
    }
    if (policy.review !== undefined) {
      assertPRReviewOptions(policy.review);
      if (policy.review.validationDepth !== 'static-code')
        throw new Error('workflow_defaults.review-pr.review requires static-code validation');
    }
  }
}

export function normalizeProjectWorkflowDefaults(
  value: unknown,
): ProjectWorkflowDefaults | undefined {
  if (value === undefined) return undefined;
  assertProjectWorkflowDefaults(value);
  return structuredClone(value);
}

export interface ResolvePRWorkflowDefaultsInput {
  /** Direct requests keep their explicit validation depth. */
  validationDepth?: ReviewValidationDepth;
  request?: PRWorkflowPolicy;
  rule?: PRWorkflowPolicy;
  repository?: PRWorkflowPolicy;
  team?: PRWorkflowPolicy;
  farm?: ProjectWorkflowDefaults;
}

export interface ResolvedPRWorkflowDefaults {
  execution?: PRExecutionProfile;
  review: PRReviewOptions;
  sources: PRWorkflowDefaultSources;
}

/** Select complete policies, preserving placement and runner restrictions at each layer. */
export function resolvePRWorkflowDefaults(
  input: ResolvePRWorkflowDefaultsInput,
): ResolvedPRWorkflowDefaults {
  const layers: Array<[PRWorkflowDefaultSource, PRWorkflowPolicy | undefined]> = [
    ['request', input.request],
    ['rule', input.rule],
    ['repository', input.repository],
    ['team', input.team],
  ];
  const higherReview = layers.find(([, policy]) => policy?.review !== undefined)?.[1]?.review;
  if (higherReview) assertPRReviewOptions(higherReview);
  const depth = input.validationDepth ?? higherReview?.validationDepth ?? 'static-code';
  const farm = normalizeProjectWorkflowDefaults(input.farm);
  if (depth === 'static-code') layers.push(['farm', farm?.['review-pr']]);
  const reviewLayer = layers.find(([, policy]) => policy?.review !== undefined);
  const selectedReview = reviewLayer?.[1]?.review;
  if (selectedReview) {
    assertPRReviewOptions(selectedReview);
    if (input.validationDepth && selectedReview.validationDepth !== input.validationDepth)
      throw new Error('Explicit validation depth conflicts with inherited review options');
  }
  const executionLayer = layers.find(([, policy]) => policy?.execution !== undefined);
  const execution = executionLayer?.[1]?.execution;
  if (execution) assertPRExecutionProfile(execution);
  return {
    ...(execution ? { execution: structuredClone(execution) } : {}),
    review: structuredClone(
      selectedReview ?? { ...DEFAULT_PR_REVIEW_OPTIONS, validationDepth: depth },
    ),
    sources: { execution: executionLayer?.[0] ?? null, review: reviewLayer?.[0] ?? 'built-in' },
  };
}
