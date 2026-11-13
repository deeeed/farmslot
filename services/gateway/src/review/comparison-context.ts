import {
  assertFreshReviewChainSelection,
  type ReviewRequestContext,
  type RunCreateParams,
} from '@farmslot/protocol';

/** Freeze the comparison default once, without reinterpreting historical run records. */
export function comparisonReviewContext(
  request: Pick<
    RunCreateParams,
    'flowType' | 'reviewValidationDepth' | 'lane' | 'variant' | 'reviewMode' | 'reviewContext'
  >,
): ReviewRequestContext | undefined {
  const context = request.reviewContext;
  if (
    request.flowType !== 'review-pr' ||
    request.reviewValidationDepth === 'full-live' ||
    request.lane !== 'comparison' ||
    !request.variant?.trim() ||
    context?.reviewLineages.some(Boolean)
  )
    return context;
  const fresh = context?.freshChain ? context : { freshChain: true, reviewLineages: [null] };
  assertFreshReviewChainSelection({ ...fresh, mode: request.reviewMode });
  return fresh;
}
