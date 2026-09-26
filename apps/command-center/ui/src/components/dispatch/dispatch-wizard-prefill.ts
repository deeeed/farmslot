import type { FlowType, ReviewRunnerId } from '@farmslot/protocol';

import type { PublicationReviewLoopDraft } from './dispatch-wizard-draft.js';

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
  publicationReviewLoops: PublicationReviewLoopDraft[];
}

const VALID_FLOWS: readonly FlowType[] = ['fix-bug', 'review-pr', 'qa', 'dev', 'pr-complete'];

export function parsePublicationReviews(
  raw: string | null,
  runnerOptions: ReadonlyArray<ReviewRunnerId>,
): PublicationReviewLoopDraft[] {
  // Older links carry `runner:depth`; review rounds are static, so only the runner is kept.
  const runners = (raw ?? '')
    .split(',')
    .map((entry) => entry.split(':')[0]?.trim() ?? '')
    .filter((runner): runner is ReviewRunnerId => runnerOptions.includes(runner as ReviewRunnerId))
    .slice(0, 5);

  return runners.map((runner, index) => ({ id: index + 1, runner }));
}

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
  const legacyDepth = params.get('reviewValidationDepth') ?? params.get('validationDepth');
  const flow = rawFlow === 'review-pr' && legacyDepth === 'full-live' ? 'qa' : rawFlow;
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
    publicationReviewLoops: parsePublicationReviews(
      params.get('publicationReviews'),
      runnerOptions,
    ),
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

export function syncPublicationReviewsHash(
  hash: string,
  loops: ReadonlyArray<PublicationReviewLoopDraft>,
): string | null {
  const raw = hash.replace('#', '');
  const qIdx = raw.indexOf('?');
  const base = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  if (!base) return null;
  const params = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
  if (loops.length > 0) {
    params.set('publicationReviews', loops.map((loop) => loop.runner).join(','));
  } else {
    params.delete('publicationReviews');
  }
  const qs = params.toString();
  return qs ? `#${base}?${qs}` : `#${base}`;
}
