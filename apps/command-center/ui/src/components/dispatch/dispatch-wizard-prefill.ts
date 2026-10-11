import type {
  FlowType,
  ReviewRequestContext,
  ReviewRunnerId,
  ReviewSequence,
} from '@farmslot/protocol';
import {
  assertReviewRequestContext,
  assertReviewSequence,
  assertWarmReviewContext,
  createReviewDispatchCatalog,
} from '@farmslot/review-dispatch';

export interface DispatchWizardPrefill {
  transport?: 'tmux' | 'native';
  base: string;
  flowType?: FlowType;
  ticketId?: string;
  project?: string;
  slot?: string;
  reviewMachine?: string;
  qaProfileId?: string;
  qaInputs?: string;
  configurationError?: string;
  startRefRedirectHash?: string;
  /** Enter comparison-lane dispatch without a pre-selected baseline run. */
  comparisonIntent?: boolean;
  comparison?: {
    familyId: string;
    variant: string;
    parentRunId: string;
    runner?: string;
    model?: string;
  };
  reviewSequence: ReviewSequence;
  reviewSequenceContext?: ReviewRequestContext;
}

const VALID_FLOWS: readonly FlowType[] = ['fix-bug', 'review-pr', 'qa', 'dev', 'pr-complete'];

export function parseDispatchWizardHash(
  hash: string,
  runnerOptions: ReadonlyArray<ReviewRunnerId>,
): DispatchWizardPrefill | null {
  const raw = hash.replace('#', '');
  const qIdx = raw.indexOf('?');
  if (qIdx < 0) return null;
  const base = raw.slice(0, qIdx) || 'dispatch';
  const params = new URLSearchParams(raw.slice(qIdx + 1));
  const rawFlow = params.get('flow');
  const flow = rawFlow;
  const reviewSequence: unknown = params.has('reviewSequence')
    ? JSON.parse(params.get('reviewSequence')!)
    : [];
  assertReviewSequence(reviewSequence, {
    catalog: createReviewDispatchCatalog({ runnerIds: runnerOptions }),
    allowEmpty: true,
  });
  const reviewSequenceContext: unknown = params.has('reviewSequenceContext')
    ? JSON.parse(params.get('reviewSequenceContext')!)
    : undefined;
  if (reviewSequenceContext !== undefined)
    assertReviewRequestContext(reviewSequenceContext, reviewSequence.length);
  assertWarmReviewContext(reviewSequence, reviewSequenceContext);
  const startRefRedirectHash = buildStartRefRedirectHash(base, params);
  const familyId = params.get('familyId') ?? '';
  const laneComparison = params.get('lane') === 'comparison';
  const intentComparison = params.get('intent') === 'comparison';
  return {
    ...(params.get('transport') === 'native' || params.get('transport') === 'tmux'
      ? { transport: params.get('transport') as 'native' | 'tmux' }
      : {}),
    base,
    flowType: flow && VALID_FLOWS.includes(flow as FlowType) ? (flow as FlowType) : undefined,
    ticketId: params.get('ticket') ?? undefined,
    project: params.get('project') ?? undefined,
    slot: params.get('slot') ?? undefined,
    ...(params.get('reviewMachine') ? { reviewMachine: params.get('reviewMachine')! } : {}),
    ...(params.get('qaProfileId') ? { qaProfileId: params.get('qaProfileId')! } : {}),
    ...(params.has('qaInputs') ? { qaInputs: params.get('qaInputs')! } : {}),
    ...(flow === 'review-pr' && params.get('slot')
      ? {
          configurationError:
            'This link selects a runtime slot. Choose QA, or explicitly choose Review and a review machine.',
        }
      : {}),
    startRefRedirectHash,
    comparisonIntent: (laneComparison || intentComparison) && !familyId,
    comparison:
      laneComparison && familyId
        ? {
            familyId,
            variant: params.get('variant') ?? '',
            parentRunId: params.get('parentRunId') ?? '',
            runner: params.get('runner') ?? undefined,
            model: params.get('model') ?? undefined,
          }
        : undefined,
    reviewSequence,
    reviewSequenceContext,
  };
}

function buildStartRefRedirectHash(base: string, params: URLSearchParams): string | undefined {
  if (!params.get('startRef') && !params.get('start_ref')) return undefined;
  const next = new URLSearchParams(params);
  next.delete('startRef');
  next.delete('start_ref');
  const qs = next.toString();
  return qs ? `#${base}?${qs}` : `#${base}`;
}

export function syncReviewSequenceHash(
  hash: string,
  sequence: ReviewSequence,
  context?: ReviewRequestContext,
): string | null {
  const raw = hash.replace('#', '');
  const qIdx = raw.indexOf('?');
  const base = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  if (!base) return null;
  const params = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
  if (sequence.length > 0) {
    assertReviewSequence(sequence, { allowEmpty: true });
    params.set('reviewSequence', JSON.stringify(sequence));
    if (context) params.set('reviewSequenceContext', JSON.stringify(context));
    else params.delete('reviewSequenceContext');
  } else {
    params.delete('reviewSequence');
    params.delete('reviewSequenceContext');
  }
  const qs = params.toString();
  return qs ? `#${base}?${qs}` : `#${base}`;
}
