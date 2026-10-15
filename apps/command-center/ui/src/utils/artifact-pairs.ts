import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

export interface PairableArtifact {
  path: string;
  purpose: string;
  runId?: string | null;
  stepName?: string | null;
}
export interface BeforeAfterPair<T> {
  before: T;
  after: T;
  stem: string;
}

/** File identity for a generic artifact matrix, never an inferred AC or role. */
export function artifactStem(path: string): string {
  return path;
}

/** Only the canonical checked projection can select a comparison pair. */
export function buildBeforeAfterPairs<T extends PairableArtifact>(
  artifacts: T[],
  model?: EvidenceReviewModel | null,
): BeforeAfterPair<T>[] {
  return (model?.pairedArtifacts(artifacts) ?? []).map(({ before, after, claimId }) => ({
    before,
    after,
    stem: claimId,
  }));
}
