import type { EvidenceReviewOccurrence } from '@farmslot/adapter-sdk/evidence';

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

/** A step's checked expectation, one `key: value` line per field. */
export function formatProofStepExpectation(
  expectation: NonNullable<EvidenceReviewOccurrence['expectation']>,
): string {
  return Object.entries(expectation)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}
