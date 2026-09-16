import type {
  ProjectWorkflowDefaults,
  PRWorkflowDefaultSource,
  PRWorkflowDefaultSources,
  PRWorkflowPolicy,
} from '../contracts/config.js';
import type { PRExecutionProfile } from '../contracts/pr-monitoring.js';
import {
  DEFAULT_PR_REVIEW_OPTIONS,
  type PRReviewOptions,
  prReviewWorkflow,
} from '../contracts/pr-rules.js';

import { assertPRExecutionProfile, isPRWorkspaceExecutionProfile } from './pr-monitoring.js';
import { assertPRReviewOptions } from './pr-rule-config.js';

function record(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} must be an object`);
}

export function assertProjectWorkflowDefaults(
  value: unknown,
): asserts value is ProjectWorkflowDefaults {
  record(value, 'workflow_defaults');
  for (const [flow, policy] of Object.entries(value)) {
    if (flow !== 'review-pr' && flow !== 'qa')
      throw new Error(`Unsupported workflow_defaults key: ${flow}`);
    record(policy, `workflow_defaults.${flow}`);
    if (
      !Object.keys(policy).length ||
      Object.keys(policy).some((key) => key !== 'execution' && key !== 'review')
    ) {
      throw new Error(`workflow_defaults.${flow} must contain execution or review only`);
    }
    if (policy.execution !== undefined) {
      assertPRExecutionProfile(policy.execution);
      if (isPRWorkspaceExecutionProfile(policy.execution) !== (flow === 'review-pr')) {
        throw new Error(
          `workflow_defaults.${flow}.execution requires ${flow === 'review-pr' ? 'workspace machines' : 'runtime slots'}`,
        );
      }
    }
    if (policy.review !== undefined) {
      assertPRReviewOptions(policy.review);
      if (flow === 'qa' && policy.review.publishReview === true)
        throw new Error('QA cannot publish a static PR review');
      if (
        policy.review.validationDepth !== undefined &&
        (policy.review.validationDepth === 'full-live') !== (flow === 'qa')
      )
        throw new Error('workflow_defaults validationDepth conflicts with its workflow key');
      if (
        policy.review.workflow !== undefined &&
        (policy.review.workflow === 'qa') !== (flow === 'qa')
      ) {
        throw new Error(
          `workflow_defaults.${flow}.review.workflow conflicts with its workflow key`,
        );
      }
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
  /** Explicit direct-dispatch workflow; intake otherwise follows its highest-priority review options. */
  workflow?: 'review-pr' | 'qa';
  request?: PRWorkflowPolicy;
  rule?: PRWorkflowPolicy;
  repository?: PRWorkflowPolicy;
  team?: PRWorkflowPolicy;
  farm?: ProjectWorkflowDefaults;
}

export interface ResolvedPRWorkflowDefaults {
  workflow: 'review-pr' | 'qa';
  execution?: PRExecutionProfile;
  review: PRReviewOptions;
  sources: PRWorkflowDefaultSources;
}

/** Select complete policies without combining targets or changing an explicitly selected runner. */
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
  const workflow = input.workflow ?? (prReviewWorkflow(higherReview) === 'qa' ? 'qa' : 'review-pr');
  const farm = normalizeProjectWorkflowDefaults(input.farm)?.[workflow];
  layers.push(['farm', farm]);
  const reviewLayer = layers.find(([, policy]) => policy?.review !== undefined);
  const selectedReview = reviewLayer?.[1]?.review;
  if (selectedReview) {
    assertPRReviewOptions(selectedReview);
    if (
      input.workflow &&
      (selectedReview.workflow !== undefined || selectedReview.validationDepth !== undefined) &&
      (prReviewWorkflow(selectedReview) === 'qa') !== (workflow === 'qa')
    ) {
      throw new Error('Explicit workflow conflicts with inherited review options');
    }
  }
  if (workflow === 'qa' && selectedReview?.publishReview === true)
    throw new Error('QA cannot publish a static PR review');
  const publicationLayer =
    workflow === 'qa'
      ? undefined
      : layers.find(([, policy]) => policy?.review?.publishReview !== undefined);
  const publishReview = publicationLayer?.[1]?.review?.publishReview;
  if (publishReview !== undefined && typeof publishReview !== 'boolean')
    throw new Error('publishReview must be boolean');
  const executionLayer = layers.find(([, policy]) => policy?.execution !== undefined);
  const execution = executionLayer?.[1]?.execution;
  if (execution) assertPRExecutionProfile(execution);
  return {
    workflow,
    ...(execution ? { execution: structuredClone(execution) } : {}),
    review: structuredClone({
      ...(selectedReview ?? DEFAULT_PR_REVIEW_OPTIONS),
      ...(publishReview === undefined ? {} : { publishReview }),
      ...(selectedReview?.workflow === undefined && selectedReview?.validationDepth === undefined
        ? { workflow: workflow === 'qa' ? ('qa' as const) : ('review' as const) }
        : {}),
    }),
    sources: {
      execution: executionLayer?.[0] ?? null,
      review: reviewLayer?.[0] ?? 'built-in',
      publication: publicationLayer?.[0] ?? 'built-in',
    },
  };
}
