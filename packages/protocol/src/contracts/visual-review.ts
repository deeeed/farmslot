export const VISUAL_REVIEW_SOURCE_VERSION = 1 as const;
export const VISUAL_REVIEW_FEEDBACK_VERSION = 1 as const;

export interface VisualReviewImageArtifact {
  path: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface VisualReviewCapture {
  id: string;
  platform: string;
  image: VisualReviewImageArtifact;
  nodeId?: string;
  proofTargets?: string[];
}

export type VisualReviewNavigationKind = 'tab' | 'push' | 'in-place' | 'modal' | 'replace';

export interface VisualReviewNavigationEdge {
  fromSurfaceId: string;
  toSurfaceId: string;
  kind: VisualReviewNavigationKind;
}

export interface VisualReviewSurface {
  id: string;
  title: string;
  location?: string;
  nodeId?: string;
  proofTargets?: string[];
  parentId?: string;
  relatedSurfaceIds?: string[];
  captures: VisualReviewCapture[];
}

export interface VisualReviewSourceDocument {
  version: typeof VISUAL_REVIEW_SOURCE_VERSION;
  kind: 'visual-review-source';
  id: string;
  title: string;
  capturedAt: string;
  description?: string;
  project?: string;
  runId?: string;
  surfaces: VisualReviewSurface[];
  /** Observed navigation paths between captured surfaces. Hierarchy remains separate. */
  navigationEdges?: VisualReviewNavigationEdge[];
}

export interface VisualReviewSurfaceNote {
  surfaceId: string;
  body: string;
}

interface VisualReviewAnnotationBase {
  id: string;
  surfaceId: string;
  captureId: string;
  body: string;
  /** User-selected marker color as a CSS hex value. */
  color?: string;
}

export interface VisualReviewPointAnnotation extends VisualReviewAnnotationBase {
  shape: 'point';
  /** Horizontal position in the intrinsic image coordinate space, normalized to 0..1. */
  x: number;
  /** Vertical position in the intrinsic image coordinate space, normalized to 0..1. */
  y: number;
}

export interface VisualReviewAreaAnnotation extends VisualReviewAnnotationBase {
  shape: 'area';
  /** Left edge in the intrinsic image coordinate space, normalized to 0..1. */
  x: number;
  /** Top edge in the intrinsic image coordinate space, normalized to 0..1. */
  y: number;
  /** Width in the intrinsic image coordinate space, normalized to 0..1. */
  width: number;
  /** Height in the intrinsic image coordinate space, normalized to 0..1. */
  height: number;
}

export interface VisualReviewFeedbackDocument {
  version: typeof VISUAL_REVIEW_FEEDBACK_VERSION;
  kind: 'visual-review-feedback';
  /** Exact source snapshot so downloaded feedback remains self-contained. */
  source: VisualReviewSourceDocument;
  surfaceNotes: VisualReviewSurfaceNote[];
  annotations: Array<VisualReviewPointAnnotation | VisualReviewAreaAnnotation>;
}
