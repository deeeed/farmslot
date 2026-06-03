import type { FlowType, ReviewRunnerId, ReviewValidationDepth } from '@farmslot/protocol';
import { isReviewValidationDepth, reviewValidationDepthForLoop } from '@farmslot/protocol';

import type { PublicationReviewLoopDraft } from './dispatch-wizard-draft.js';

export interface DispatchWizardPrefill {
  base: string;
  flowType?: FlowType;
  ticketId?: string;
  project?: string;
  slot?: string;
  startRefRedirectHash?: string;
  comparison?: {
    familyId: string;
    variant: string;
    parentRunId: string;
    runner?: string;
    model?: string;
  };
  publicationReviewLoops: PublicationReviewLoopDraft[];
}

const VALID_FLOWS: readonly FlowType[] = ['fix-bug', 'review-pr', 'dev', 'pr-complete'];

export function parsePublicationReviews(
  raw: string | null,
  runnerOptions: ReadonlyArray<ReviewRunnerId>,
): PublicationReviewLoopDraft[] {
  const loops = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): { runner: string; validationDepth?: ReviewValidationDepth } => {
      const [runnerRaw, depthRaw] = entry.split(':');
      const runner = runnerRaw?.trim();
      return {
        runner: runner ?? '',
        validationDepth: isReviewValidationDepth(depthRaw) ? depthRaw : undefined,
      };
    })
    .filter((loop): loop is { runner: ReviewRunnerId; validationDepth?: ReviewValidationDepth } =>
      runnerOptions.includes(loop.runner as ReviewRunnerId),
    )
    .slice(0, 5);

  return loops.map((loop, index) => ({
    id: index + 1,
    runner: loop.runner,
    validationDepth: loop.validationDepth ?? reviewValidationDepthForLoop(index, loops.length),
  }));
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
  const flow = params.get('flow');
  const startRefRedirectHash = buildStartRefRedirectHash(base, params);
  const familyId = params.get('familyId') ?? '';
  return {
    base,
    flowType: flow && VALID_FLOWS.includes(flow as FlowType) ? (flow as FlowType) : undefined,
    ticketId: params.get('ticket') ?? undefined,
    project: params.get('project') ?? undefined,
    slot: params.get('slot') ?? undefined,
    startRefRedirectHash,
    comparison:
      params.get('lane') === 'comparison' && familyId
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

export function shouldUsePrefillSlot(
  slot: string | undefined,
  activeMachines: ReadonlyArray<string>,
): boolean {
  if (!slot) return false;
  if (activeMachines.length === 0) return true;
  return activeMachines.some((machine) => slot === machine || slot.startsWith(`${machine}-`));
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
    params.set(
      'publicationReviews',
      loops
        .map(
          (loop, index) =>
            `${loop.runner}:${loop.validationDepth ?? reviewValidationDepthForLoop(index, loops.length)}`,
        )
        .join(','),
    );
  } else {
    params.delete('publicationReviews');
  }
  const qs = params.toString();
  return qs ? `#${base}?${qs}` : `#${base}`;
}
