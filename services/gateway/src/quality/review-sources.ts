export type ReviewSourceKind = 'pipeline' | 'requested';

export interface ReviewArtifactRefs {
  /** Globally-unique id for the ReviewStatus entry. */
  readonly id: string;
  /** Workspace-relative path to the JSON artifact (`artifacts/...`). */
  readonly jsonRel: string;
  /** Workspace-relative path to the Markdown artifact (`artifacts/...`). */
  readonly mdRel: string;
}

export interface ReviewSource {
  readonly kind: ReviewSourceKind;
  /** Canonical prefix used by both id and artifact filenames (no trailing dash). */
  readonly idPrefix: string;
  artifactRefs(loopNumber: number, lineage?: string): ReviewArtifactRefs;
}

class ReviewSourceImpl implements ReviewSource {
  readonly kind = 'pipeline' as const;
  readonly idPrefix = 'pipeline-review';
  artifactRefs(loopNumber: number, lineage?: string): ReviewArtifactRefs {
    return {
      id: `${this.idPrefix}-${lineage ?? loopNumber}`,
      jsonRel: `artifacts/${this.idPrefix}-${lineage ?? loopNumber}.json`,
      mdRel: `artifacts/${this.idPrefix}-${lineage ?? loopNumber}.md`,
    };
  }
}

class RequestedReviewSourceImpl implements ReviewSource {
  readonly kind = 'requested' as const;
  readonly idPrefix = 'review';
  artifactRefs(loopNumber: number, lineage?: string): ReviewArtifactRefs {
    return {
      id: `${this.idPrefix}-${lineage ?? loopNumber}`,
      jsonRel: `artifacts/${this.idPrefix}-${lineage ?? loopNumber}.json`,
      mdRel: `artifacts/${this.idPrefix}-${lineage ?? loopNumber}.md`,
    };
  }
}

export const PIPELINE_REVIEW_SOURCE: ReviewSource = Object.freeze(new ReviewSourceImpl());
export const REQUESTED_REVIEW_SOURCE: ReviewSource = Object.freeze(new RequestedReviewSourceImpl());

export const REVIEW_SOURCES: Readonly<Record<ReviewSourceKind, ReviewSource>> = Object.freeze({
  pipeline: PIPELINE_REVIEW_SOURCE,
  requested: REQUESTED_REVIEW_SOURCE,
});

export function reviewLoopNumberFromId(source: ReviewSource, id: string): number | null {
  const prefix = `${source.idPrefix}-`;
  if (!id.startsWith(prefix)) return null;
  const loopNumber = Number(id.slice(prefix.length));
  return Number.isInteger(loopNumber) && loopNumber > 0 ? loopNumber : null;
}

/**
 * Pure registry-driven mapping from a review id to its source kind. Iterates
 * the frozen REVIEW_SOURCES and matches the canonical `${prefix}-` shape.
 * Adding a new ReviewSourceKind is a pure addition — register the source and
 * this inferrer picks it up with no edits here.
 *
 * Throws on unknown ids. The product is pre-launch and every review entry
 * must be produced through a ReviewSource; an unknown id is a programming
 * bug, not a legacy case to silently bucket.
 */
export function inferReviewSourceKind(review: { id: string }): ReviewSourceKind {
  for (const kind of Object.keys(REVIEW_SOURCES) as ReviewSourceKind[]) {
    if (review.id.startsWith(`${REVIEW_SOURCES[kind].idPrefix}-`)) return kind;
  }
  throw new Error(
    `Unknown review id prefix: ${review.id} — must be produced through a ReviewSource`,
  );
}
