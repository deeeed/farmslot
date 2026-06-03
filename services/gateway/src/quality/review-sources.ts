/**
 * Publish-gate review source abstraction. Two streams write into
 * `engineState.publishGate.independentReviews`:
 *
 *   1. Self-review (worker's own attempt loops).
 *   2. Extra-review (operator-requested cross-runner or repeat reviews
 *      emitted from the human gate or chained dispatch).
 *
 * Each stream owns a distinct id namespace + artifact-path scheme so the Map
 * merge in `prepareCompletionPackage` cannot silently overwrite one with the
 * other — a regression that previously erased operator-requested reviews when
 * a self-review attempt happened to land on the same loop number.
 *
 * Callers MUST route through a `ReviewSource` instance to produce ids and
 * artifact paths. Never construct these strings inline; the format lives here.
 *
 * Adding a third source (e.g. cross-runner-audit) = new class + frozen export
 * + entry in `REVIEW_SOURCES`. No call site needs to know the literal naming.
 */

export type ReviewSourceKind = 'self-review' | 'extra-review';

export interface ReviewArtifactRefs {
  /** Globally-unique id for the IndependentReviewStatus entry. */
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
  artifactRefs(loopNumber: number): ReviewArtifactRefs;
}

class SelfReviewSourceImpl implements ReviewSource {
  readonly kind = 'self-review' as const;
  readonly idPrefix = 'self-review';
  artifactRefs(loopNumber: number): ReviewArtifactRefs {
    return {
      id: `${this.idPrefix}-${loopNumber}`,
      jsonRel: `artifacts/${this.idPrefix}-${loopNumber}.json`,
      mdRel: `artifacts/${this.idPrefix}-${loopNumber}.md`,
    };
  }
}

class ExtraReviewSourceImpl implements ReviewSource {
  readonly kind = 'extra-review' as const;
  readonly idPrefix = 'independent-review';
  artifactRefs(loopNumber: number): ReviewArtifactRefs {
    return {
      id: `${this.idPrefix}-${loopNumber}`,
      jsonRel: `artifacts/${this.idPrefix}-${loopNumber}.json`,
      mdRel: `artifacts/${this.idPrefix}-${loopNumber}.md`,
    };
  }
}

export const SELF_REVIEW_SOURCE: ReviewSource = Object.freeze(new SelfReviewSourceImpl());
export const EXTRA_REVIEW_SOURCE: ReviewSource = Object.freeze(new ExtraReviewSourceImpl());

export const REVIEW_SOURCES: Readonly<Record<ReviewSourceKind, ReviewSource>> = Object.freeze({
  'self-review': SELF_REVIEW_SOURCE,
  'extra-review': EXTRA_REVIEW_SOURCE,
});

/**
 * Composite merge key used by `prepareCompletionPackage` when reconciling
 * priorReviews against materialized reviews. Keying on (sourceKind, loopNumber)
 * makes accidental id collisions across streams impossible — defense in depth
 * if a future caller bypasses the source helpers.
 */
export function reviewCompositeKey(source: ReviewSourceKind, loopNumber: number): string {
  return `${source}::${loopNumber}`;
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
