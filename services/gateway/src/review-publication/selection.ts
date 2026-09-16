import { isDeepStrictEqual } from 'node:util';

import type { ReviewGatePayload, Run, RunReviewResult } from '@farmslot/protocol';

import { findLatestResolvedDecision } from '../run-engine/decision-replay.js';

export function approvedReviewDecision(run: Run) {
  const decision = findLatestResolvedDecision(run.decisions, 'review_posting');
  if (decision?.resolvedAction !== 'post') return undefined;
  const payload = decision.payload as ReviewGatePayload | undefined;
  const result = run.reviewResult;
  if (
    !result ||
    !payload ||
    !isDeepStrictEqual(payload.reviewSnapshot, result.reviewSnapshot) ||
    payload.reviewMd !== result.reviewMd ||
    payload.recommendation !== result.recommendation ||
    !isDeepStrictEqual(payload.lineComments, result.lineComments)
  )
    throw new Error('Review changed after the publication decision');
  return decision;
}

/** Keep the original report intact; apply the operator's curation only when publishing. */
export function selectedReviewResult(run: Run): RunReviewResult | undefined {
  const result = run.reviewResult;
  const selection = approvedReviewDecision(run)?.selectionData;
  if (!result || !selection) return result;
  const recommendation = selection.recommendation ?? result.recommendation;
  if (
    typeof recommendation !== 'string' ||
    !['APPROVE', 'COMMENT', 'REQUEST_CHANGES'].includes(recommendation)
  )
    throw new Error('Invalid selected review recommendation');
  const indices = selection.includedIndices;
  if (
    indices !== undefined &&
    (!Array.isArray(indices) ||
      indices.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= result.lineComments.length,
      ))
  )
    throw new Error('Invalid selected review comments');
  return {
    ...result,
    recommendation,
    lineComments:
      indices === undefined
        ? result.lineComments
        : result.lineComments.filter((_, index) => (indices as number[]).includes(index)),
  };
}
