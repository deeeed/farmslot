import type {
  EvidenceReviewClaim,
  EvidenceReviewModel,
  EvidenceReviewOccurrence,
} from './evidence-review-model.js';

/** The recipe steps that prove one criterion, in trace order; or the steps that prove none. */
export interface ProofStepGroup {
  /** Criterion id, or `Other steps` for setup, navigation and teardown. */
  label: string;
  steps: EvidenceReviewOccurrence[];
  failed: number;
}

export const OTHER_PROOF_STEPS = 'Other steps';

/** One group per proven criterion in id order, then the steps that prove nothing. */
export function proofStepGroups(
  occurrences: readonly EvidenceReviewOccurrence[],
): ProofStepGroup[] {
  const byLabel = new Map<string, EvidenceReviewOccurrence[]>();
  for (const step of occurrences)
    for (const label of step.proves.length ? step.proves : [OTHER_PROOF_STEPS])
      byLabel.set(label, [...(byLabel.get(label) ?? []), step]);
  return [...byLabel]
    .sort(([a], [b]) =>
      a === OTHER_PROOF_STEPS
        ? 1
        : b === OTHER_PROOF_STEPS
          ? -1
          : a.localeCompare(b, undefined, { numeric: true }),
    )
    .map(([label, steps]) => ({ label, steps, failed: steps.filter((step) => !step.ok).length }));
}

/** One criterion in a recording's table of contents. */
export interface EvidenceReviewTocEntry<Claim extends { id: string } = EvidenceReviewClaim> {
  claim: Claim;
  /** The steps that prove the criterion, the same grouping the proof step list shows. */
  steps: readonly EvidenceReviewOccurrence[];
  /** Where the criterion's first recorded step starts, or null when the recording misses it. */
  startMs: number | null;
}

/**
 * A recording's table of contents: every criterion with the moment the recording reaches it.
 * Video order lists criteria by that moment, the ones the recording misses last; criteria
 * order keeps the run's own order. Both clients' evidence reviews read this.
 */
export function evidenceReviewToc<Claim extends { id: string } = EvidenceReviewClaim>(
  model: Pick<EvidenceReviewModel, 'occurrences' | 'markerSeekMs'> & { claims: readonly Claim[] },
  videoPath: string | null | undefined,
  options: { order?: 'video' | 'criteria'; mediaDurationMs?: number } = {},
): EvidenceReviewTocEntry<Claim>[] {
  const groups = proofStepGroups(model.occurrences);
  const entries = model.claims.map((claim) => {
    const steps = groups.find((group) => group.label === claim.id)?.steps ?? [];
    const startMs = videoPath
      ? (steps
          .map((step) =>
            model.markerSeekMs(videoPath, step.traceIndex, 'start', options.mediaDurationMs),
          )
          .find((ms) => ms !== null) ?? null)
      : null;
    return { claim, steps, startMs };
  });
  return options.order === 'criteria'
    ? entries
    : entries.sort(
        (a, b) => (a.startMs ?? Number.POSITIVE_INFINITY) - (b.startMs ?? Number.POSITIVE_INFINITY),
      );
}

/** The criterion before or after `claimId` in the table of contents, or null at either end. */
export function adjacentEvidenceReviewClaim(
  toc: readonly EvidenceReviewTocEntry<{ id: string }>[],
  claimId: string,
  direction: -1 | 1,
): string | null {
  const index = toc.findIndex((entry) => entry.claim.id === claimId);
  if (index < 0) return null;
  return toc[index + direction]?.claim.id ?? null;
}
