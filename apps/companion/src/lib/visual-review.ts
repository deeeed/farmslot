import type {
  VisualReviewAnnotation,
  VisualReviewFeedbackDocument,
  VisualReviewFeedbackDraft,
  VisualReviewNavigationKind,
  VisualReviewSourceDocument,
  VisualReviewSurface,
} from '@farmslot/protocol';

import type { ArtifactManifestEntry } from './artifact-url';

export const VISUAL_REVIEW_SOURCE_FILENAME = 'visual-review-source.json';

/** Same order as the HTML board so both renderers pick the same default marker colors. */
export const VISUAL_REVIEW_PALETTE = [
  '#5855ee',
  '#e84a8a',
  '#20b486',
  '#f29d38',
  '#38a9f2',
  '#b266e8',
] as const;

/** Smallest area either renderer keeps, in normalized image units. */
export const VISUAL_REVIEW_MIN_AREA = 0.01;

export function findVisualReviewSourceArtifacts(
  artifacts: readonly ArtifactManifestEntry[],
): ArtifactManifestEntry[] {
  return artifacts.filter(
    (artifact) => artifact.path.split('/').pop() === VISUAL_REVIEW_SOURCE_FILENAME,
  );
}

/** Image paths are relative to the source document; `..` may climb to, but not past, the run artifact root. */
export function visualReviewImageArtifactPath(sourcePath: string, imagePath: string): string {
  const segments = sourcePath.split('/').slice(0, -1);
  for (const segment of imagePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`Visual review image ${imagePath} escapes the run artifacts.`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export interface VisualReviewSurfaceLinks {
  surface: VisualReviewSurface;
  ancestors: VisualReviewSurface[];
  children: VisualReviewSurface[];
  related: VisualReviewSurface[];
  incoming: Array<{ from: VisualReviewSurface; kind: VisualReviewNavigationKind }>;
}

export function visualReviewSurfaceLinks(
  source: VisualReviewSourceDocument,
  surfaceId: string,
): VisualReviewSurfaceLinks {
  const byId = new Map(source.surfaces.map((surface) => [surface.id, surface]));
  const surface = byId.get(surfaceId);
  if (!surface) throw new Error(`Visual review surface ${surfaceId} is not in ${source.id}.`);
  const ancestors: VisualReviewSurface[] = [];
  for (let parent = byId.get(surface.parentId ?? ''); parent; ) {
    ancestors.unshift(parent);
    parent = byId.get(parent.parentId ?? '');
  }
  return {
    surface,
    ancestors,
    children: source.surfaces.filter((candidate) => candidate.parentId === surface.id),
    related: (surface.relatedSurfaceIds ?? []).flatMap((id) => byId.get(id) ?? []),
    incoming: (source.navigationEdges ?? []).flatMap((edge) => {
      const from = byId.get(edge.fromSurfaceId);
      return edge.toSurfaceId === surface.id && from ? [{ from, kind: edge.kind }] : [];
    }),
  };
}

export function emptyVisualReviewDraft(): VisualReviewFeedbackDraft {
  return { surfaceNotes: {}, annotations: [] };
}

function nextAnnotationId(annotations: readonly VisualReviewAnnotation[]): string {
  const highest = annotations.reduce((max, annotation) => {
    const match = /^annotation-(\d+)$/u.exec(annotation.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `annotation-${highest + 1}`;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export type VisualReviewAnnotationInput =
  | { shape: 'point'; x: number; y: number }
  | { shape: 'area'; x: number; y: number; width: number; height: number };

/** Returns the draft unchanged when an area is too small to be intentional. */
export function addVisualReviewAnnotation(
  draft: VisualReviewFeedbackDraft,
  target: { surfaceId: string; captureId: string },
  input: VisualReviewAnnotationInput,
): { draft: VisualReviewFeedbackDraft; annotation?: VisualReviewAnnotation } {
  const color = VISUAL_REVIEW_PALETTE[draft.annotations.length % VISUAL_REVIEW_PALETTE.length];
  const base = { id: nextAnnotationId(draft.annotations), ...target, color, body: '' };
  let annotation: VisualReviewAnnotation;
  if (input.shape === 'point') {
    annotation = { ...base, shape: 'point', x: clampUnit(input.x), y: clampUnit(input.y) };
  } else {
    const x = clampUnit(input.x);
    const y = clampUnit(input.y);
    const width = Math.min(clampUnit(input.width), 1 - x);
    const height = Math.min(clampUnit(input.height), 1 - y);
    if (width < VISUAL_REVIEW_MIN_AREA || height < VISUAL_REVIEW_MIN_AREA) return { draft };
    annotation = { ...base, shape: 'area', x, y, width, height };
  }
  return { draft: { ...draft, annotations: [...draft.annotations, annotation] }, annotation };
}

/** Moves an annotation by a normalized delta, keeping areas fully inside the image. */
export function moveVisualReviewAnnotation(
  draft: VisualReviewFeedbackDraft,
  annotationId: string,
  delta: { x: number; y: number },
): VisualReviewFeedbackDraft {
  return {
    ...draft,
    annotations: draft.annotations.map((annotation) => {
      if (annotation.id !== annotationId) return annotation;
      const maxX = annotation.shape === 'area' ? 1 - annotation.width : 1;
      const maxY = annotation.shape === 'area' ? 1 - annotation.height : 1;
      return {
        ...annotation,
        x: Math.max(0, Math.min(maxX, annotation.x + delta.x)),
        y: Math.max(0, Math.min(maxY, annotation.y + delta.y)),
      };
    }),
  };
}

export function updateVisualReviewAnnotation(
  draft: VisualReviewFeedbackDraft,
  annotationId: string,
  patch: { body?: string; color?: string },
): VisualReviewFeedbackDraft {
  return {
    ...draft,
    annotations: draft.annotations.map((annotation) =>
      annotation.id === annotationId ? { ...annotation, ...patch } : annotation,
    ),
  };
}

export function removeVisualReviewAnnotation(
  draft: VisualReviewFeedbackDraft,
  annotationId: string,
): VisualReviewFeedbackDraft {
  return {
    ...draft,
    annotations: draft.annotations.filter((annotation) => annotation.id !== annotationId),
  };
}

export function setVisualReviewSurfaceNote(
  draft: VisualReviewFeedbackDraft,
  surfaceId: string,
  body: string,
): VisualReviewFeedbackDraft {
  return { ...draft, surfaceNotes: { ...draft.surfaceNotes, [surfaceId]: body } };
}

/**
 * Worker messages travel as one `tmux send-keys -l` argument, which tmux 3.7 refuses at about
 * 16 KB ("command too long"). The cap leaves room for quoting; larger feedback is exported instead.
 */
export const VISUAL_REVIEW_MESSAGE_MAX_BYTES = 15_000;

export function visualReviewMessageBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * One-line worker input: `terminal.send` submits on Enter, so the document is compact JSON.
 * The preamble states that feedback is not an approval.
 */
export function visualReviewFeedbackMessage(document: VisualReviewFeedbackDocument): string {
  const { source } = document;
  return [
    `Operator visual review feedback for ${source.id} (captured ${source.capturedAt}):`,
    `${document.surfaceNotes.length} surface note(s), ${document.annotations.length} annotation(s).`,
    'This is review feedback, not an approval. Apply it, then recapture the affected surfaces.',
    `VisualReviewFeedbackDocument: ${JSON.stringify(document)}`,
  ].join(' ');
}
