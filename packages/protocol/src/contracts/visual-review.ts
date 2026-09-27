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
  annotations: VisualReviewAnnotation[];
}

export const VISUAL_REVIEW_NAVIGATION_KINDS: readonly VisualReviewNavigationKind[] = [
  'tab',
  'push',
  'in-place',
  'modal',
  'replace',
];

const VISUAL_REVIEW_COLOR = /^#[0-9a-f]{6}$/iu;

export interface VisualReviewValidationResult<T> {
  ok: boolean;
  document?: T;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function collectSourceErrors(value: unknown, errors: string[], prefix: string): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (value.version !== VISUAL_REVIEW_SOURCE_VERSION) {
    errors.push(`${prefix}.version must be ${VISUAL_REVIEW_SOURCE_VERSION}`);
  }
  if (value.kind !== 'visual-review-source') {
    errors.push(`${prefix}.kind must be "visual-review-source"`);
  }
  for (const field of ['id', 'title', 'capturedAt'] as const) {
    if (!isNonEmptyString(value[field]))
      errors.push(`${prefix}.${field} must be a non-empty string`);
  }
  if (value.runId != null && !isNonEmptyString(value.runId)) {
    errors.push(`${prefix}.runId must be a non-empty string when present`);
  }
  if (!Array.isArray(value.surfaces) || value.surfaces.length === 0) {
    errors.push(`${prefix}.surfaces must be a non-empty array`);
    return;
  }
  const surfaces: unknown[] = value.surfaces;
  const surfaceIds = new Set<string>();
  surfaces.forEach((surface, index) => {
    const at = `${prefix}.surfaces[${index}]`;
    if (!isRecord(surface)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(surface.id)) errors.push(`${at}.id must be a non-empty string`);
    else if (surfaceIds.has(surface.id)) errors.push(`${at}.id must be unique`);
    else surfaceIds.add(surface.id);
    if (!isNonEmptyString(surface.title)) errors.push(`${at}.title must be a non-empty string`);
    if (!Array.isArray(surface.captures)) {
      errors.push(`${at}.captures must be an array`);
      return;
    }
    const captureIds = new Set<string>();
    surface.captures.forEach((capture: unknown, captureIndex: number) => {
      const captureAt = `${at}.captures[${captureIndex}]`;
      if (!isRecord(capture)) {
        errors.push(`${captureAt} must be an object`);
        return;
      }
      if (!isNonEmptyString(capture.id)) errors.push(`${captureAt}.id must be a non-empty string`);
      else if (captureIds.has(capture.id)) errors.push(`${captureAt}.id must be unique`);
      else captureIds.add(capture.id);
      if (!isNonEmptyString(capture.platform)) {
        errors.push(`${captureAt}.platform must be a non-empty string`);
      }
      if (!isRecord(capture.image) || !isNonEmptyString(capture.image.path)) {
        errors.push(`${captureAt}.image.path must be a non-empty string`);
      } else {
        // Renderers size their canvas from these; zero or negative would divide by nothing.
        for (const key of ['width', 'height'] as const) {
          const value = capture.image[key];
          if (
            value != null &&
            !(typeof value === 'number' && Number.isFinite(value) && value > 0)
          ) {
            errors.push(`${captureAt}.image.${key} must be a positive number`);
          }
        }
      }
    });
  });
  const byId = new Map(
    surfaces.filter(isRecord).map((surface) => [surface.id as string, surface] as const),
  );
  surfaces.forEach((surface, index) => {
    if (!isRecord(surface)) return;
    const at = `${prefix}.surfaces[${index}]`;
    if (surface.parentId != null && !surfaceIds.has(surface.parentId as string)) {
      errors.push(`${at}.parentId references a missing surface`);
    }
    if (surface.relatedSurfaceIds != null) {
      if (!Array.isArray(surface.relatedSurfaceIds)) {
        errors.push(`${at}.relatedSurfaceIds must be an array`);
      } else if (surface.relatedSurfaceIds.some((id: unknown) => !surfaceIds.has(id as string))) {
        errors.push(`${at}.relatedSurfaceIds references a missing surface`);
      }
    }
    const seen = new Set<unknown>();
    let current: Record<string, unknown> | undefined = surface;
    while (current?.parentId != null) {
      if (seen.has(current.id)) {
        errors.push(`${at} parent hierarchy contains a cycle`);
        break;
      }
      seen.add(current.id);
      current = byId.get(current.parentId as string);
    }
  });
  if (value.navigationEdges != null) {
    if (!Array.isArray(value.navigationEdges)) {
      errors.push(`${prefix}.navigationEdges must be an array`);
      return;
    }
    value.navigationEdges.forEach((edge: unknown, index: number) => {
      const at = `${prefix}.navigationEdges[${index}]`;
      if (
        !isRecord(edge) ||
        !surfaceIds.has(edge.fromSurfaceId as string) ||
        !surfaceIds.has(edge.toSurfaceId as string)
      ) {
        errors.push(`${at} must reference existing surfaces`);
        return;
      }
      if (!VISUAL_REVIEW_NAVIGATION_KINDS.includes(edge.kind as VisualReviewNavigationKind)) {
        errors.push(`${at}.kind must be one of ${VISUAL_REVIEW_NAVIGATION_KINDS.join(', ')}`);
      }
    });
  }
}

export function validateVisualReviewSourceDocument(
  value: unknown,
): VisualReviewValidationResult<VisualReviewSourceDocument> {
  const errors: string[] = [];
  collectSourceErrors(value, errors, 'source');
  return errors.length
    ? { ok: false, errors }
    : { ok: true, document: value as VisualReviewSourceDocument, errors };
}

/**
 * Runs every feedback check, collecting failures into `errors`; the value is a feedback document
 * only when none fail. Surface and capture ids are checked against the embedded source snapshot.
 */
function isVisualReviewFeedbackDocument(
  value: unknown,
  errors: string[],
): value is VisualReviewFeedbackDocument {
  if (!isRecord(value)) {
    errors.push('feedback must be an object');
    return false;
  }
  if (value.version !== VISUAL_REVIEW_FEEDBACK_VERSION) {
    errors.push(`version must be ${VISUAL_REVIEW_FEEDBACK_VERSION}`);
  }
  if (value.kind !== 'visual-review-feedback') {
    errors.push('kind must be "visual-review-feedback"');
  }
  const sourceErrors: string[] = [];
  collectSourceErrors(value.source, sourceErrors, 'source');
  errors.push(...sourceErrors);
  const source = sourceErrors.length ? null : (value.source as VisualReviewSourceDocument);
  const surfaceIds = new Set(source?.surfaces.map((surface) => surface.id));
  const captureKeys = new Set(
    source?.surfaces.flatMap((surface) =>
      surface.captures.map((capture) => `${surface.id}\u0000${capture.id}`),
    ),
  );
  if (!Array.isArray(value.surfaceNotes)) {
    errors.push('surfaceNotes must be an array');
  } else {
    const noted = new Set<string>();
    value.surfaceNotes.forEach((note: unknown, index: number) => {
      const at = `surfaceNotes[${index}]`;
      if (!isRecord(note) || !isNonEmptyString(note.body)) {
        errors.push(`${at}.body must be a non-empty string`);
        return;
      }
      if (source && !surfaceIds.has(note.surfaceId as string)) {
        errors.push(`${at}.surfaceId must reference a source surface`);
      } else if (noted.has(note.surfaceId as string)) {
        errors.push(`${at}.surfaceId must be unique`);
      }
      noted.add(note.surfaceId as string);
    });
  }
  if (!Array.isArray(value.annotations)) {
    errors.push('annotations must be an array');
  } else {
    const annotationIds = new Set<string>();
    value.annotations.forEach((annotation: unknown, index: number) => {
      const at = `annotations[${index}]`;
      if (!isRecord(annotation)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!isNonEmptyString(annotation.id)) errors.push(`${at}.id must be a non-empty string`);
      else if (annotationIds.has(annotation.id)) errors.push(`${at}.id must be unique`);
      else annotationIds.add(annotation.id);
      if (!isNonEmptyString(annotation.body)) errors.push(`${at}.body must be a non-empty string`);
      if (
        source &&
        !captureKeys.has(`${String(annotation.surfaceId)}\u0000${String(annotation.captureId)}`)
      ) {
        errors.push(`${at} must reference a source surface capture`);
      }
      if (annotation.color != null && !VISUAL_REVIEW_COLOR.test(String(annotation.color))) {
        errors.push(`${at}.color must be a #rrggbb hex value`);
      }
      if (!isUnitInterval(annotation.x) || !isUnitInterval(annotation.y)) {
        errors.push(`${at}.x and y must be normalized to 0..1`);
        return;
      }
      if (annotation.shape === 'area') {
        if (
          !isUnitInterval(annotation.width) ||
          !isUnitInterval(annotation.height) ||
          annotation.width === 0 ||
          annotation.height === 0 ||
          annotation.x + annotation.width > 1 + 1e-9 ||
          annotation.y + annotation.height > 1 + 1e-9
        ) {
          errors.push(`${at} area must have a positive size inside the image`);
        }
      } else if (annotation.shape !== 'point') {
        errors.push(`${at}.shape must be "point" or "area"`);
      }
    });
  }
  return errors.length === 0;
}

export function validateVisualReviewFeedbackDocument(
  value: unknown,
): VisualReviewValidationResult<VisualReviewFeedbackDocument> {
  const errors: string[] = [];
  return isVisualReviewFeedbackDocument(value, errors)
    ? { ok: true, document: value, errors }
    : { ok: false, errors };
}

export type VisualReviewAnnotation = VisualReviewPointAnnotation | VisualReviewAreaAnnotation;

/** Editable renderer state; notes are keyed by surface id. */
export interface VisualReviewFeedbackDraft {
  surfaceNotes: Record<string, string>;
  annotations: VisualReviewAnnotation[];
}

/**
 * Builds the portable document every renderer exports: blank feedback and ids absent from the
 * source snapshot are dropped, matching the HTML board's download.
 */
export function createVisualReviewFeedbackDocument(
  source: VisualReviewSourceDocument,
  draft: VisualReviewFeedbackDraft,
): VisualReviewFeedbackDocument {
  const surfaceIds = new Set(source.surfaces.map((surface) => surface.id));
  const captureKeys = new Set(
    source.surfaces.flatMap((surface) =>
      surface.captures.map((capture) => `${surface.id}\u0000${capture.id}`),
    ),
  );
  return {
    version: VISUAL_REVIEW_FEEDBACK_VERSION,
    kind: 'visual-review-feedback',
    source,
    surfaceNotes: Object.entries(draft.surfaceNotes)
      .filter(([surfaceId, body]) => surfaceIds.has(surfaceId) && body.trim())
      .map(([surfaceId, body]) => ({ surfaceId, body })),
    annotations: draft.annotations
      .filter(
        (annotation) =>
          captureKeys.has(`${annotation.surfaceId}\u0000${annotation.captureId}`) &&
          annotation.body.trim(),
      )
      .map((annotation) => ({ ...annotation })),
  };
}
