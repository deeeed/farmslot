import {
  type ArtifactRef,
  EVIDENCE_PADDING_MS,
  type RecipeEvidenceCaptureBinding,
  type RecordedEvidencePackageInput,
  type ReviewDiffSnapshot,
} from '@farmslot/protocol';
import {
  groupRecipeCaptureComparisons,
  indexRecordingTimelines,
  occurrenceRecordingCoverage,
} from '@farmslot/recipe-runner/evidence';

import type {
  EvidenceReviewArtifact,
  EvidenceReviewClaim,
  EvidenceReviewClip,
} from './evidence-review-model.js';

export type EvidenceReviewComparisonFilter =
  | 'all'
  | 'before'
  | 'after'
  | 'review'
  | 'screenshots'
  | 'moments'
  | 'unassigned';
export interface EvidenceReviewComparisonMedia extends EvidenceReviewArtifact {
  identity: string;
  originalPath: string;
  recipeRunId?: string;
  capture?: RecipeEvidenceCaptureBinding;
  clips: readonly EvidenceReviewClip[];
  limitation?: string;
  limitationCode?: 'comparison-source-unavailable' | 'comparison-source-mismatch';
  timing: 'measured' | 'untimed' | 'outside-recording';
  eligible: boolean;
}
export interface EvidenceReviewComparisonRow {
  claim: EvidenceReviewClaim;
  sourceUrl?: string;
  before: readonly EvidenceReviewComparisonMedia[];
  after: readonly EvidenceReviewComparisonMedia[];
  review: readonly EvidenceReviewComparisonMedia[];
  selectedBefore?: EvidenceReviewComparisonMedia;
  selectedAfter?: EvidenceReviewComparisonMedia;
}
export interface EvidenceReviewComparisonTransform {
  scale: number;
  x: number;
  y: number;
}

/** One grouping and source check for both clients. Missing bindings never become pairs. */
export function projectEvidenceComparisons(
  pkg: RecordedEvidencePackageInput | undefined,
  claims: readonly EvidenceReviewClaim[],
  prefix: string,
  inventory: readonly ArtifactRef[],
  snapshot?: Pick<ReviewDiffSnapshot, 'baseSha' | 'headSha'>,
  sourceUrl?: string,
  invalid = false,
): {
  rows: EvidenceReviewComparisonRow[];
  unassigned: EvidenceReviewComparisonMedia[];
  media: EvidenceReviewComparisonMedia[];
} {
  const rows = claims.map(
    (claim): EvidenceReviewComparisonRow => ({
      claim,
      sourceUrl,
      before: [],
      after: [],
      review: [],
    }),
  );
  const byClaim = new Map(rows.map((row) => [row.claim.id, row]));
  const media: EvidenceReviewComparisonMedia[] = [];
  const unassigned: EvidenceReviewComparisonMedia[] = [];
  const grouped = pkg ? groupRecipeCaptureComparisons(pkg, claims, snapshot) : { media: [] };
  for (const original of grouped.media) {
    const capture = original.capture;
    const source = original.source;
    const timelines = indexRecordingTimelines(Object.values(source.timelines));
    const coverage =
      capture && !invalid
        ? occurrenceRecordingCoverage(
            capture.traceIndex,
            source.claims?.recording.segments ?? [],
            timelines,
          )
        : { timing: 'untimed' as const, segments: [] };
    const candidate: EvidenceReviewComparisonMedia = {
      path: original.path,
      artifactPath: `${prefix}${original.path}`,
      originalPath: original.originalPath,
      identity: `${source.claims?.recipeRunId ?? 'unbound'}:${original.path}`,
      recipeRunId: source.claims?.recipeRunId,
      capture,
      name: original.label,
      mediaType: original.type === 'screenshot' ? 'image' : 'video',
      timing: coverage.timing,
      eligible: original.eligible && !invalid,
      limitation: original.reason,
      limitationCode: original.reasonCode,
      clips:
        coverage.timing === 'measured'
          ? coverage.segments.map((segment) => {
              const timeline = timelines.get(segment.videoPath)!;
              const marker = timeline.markers.find(
                (entry) => entry.traceIndex === capture!.traceIndex,
              )!;
              return {
                videoPath: `${original.root}${segment.videoPath}`,
                videoDigest: segment.videoDigest,
                traceIndex: capture!.traceIndex,
                momentMs: (marker.startRangeMs[0] + marker.startRangeMs[1]) / 2,
                startMs: Math.max(0, marker.startRangeMs[0] - EVIDENCE_PADDING_MS),
                endMs: Math.min(timeline.durationMs, marker.endRangeMs[1] + EVIDENCE_PADDING_MS),
                caption: original.label,
                moment: {
                  recipeRunId: capture!.recipeRunId,
                  videoDigest: segment.videoDigest,
                  traceIndex: capture!.traceIndex,
                },
              };
            })
          : [],
    };
    candidate.limitation ??=
      coverage.timing === 'measured'
        ? undefined
        : coverage.timing === 'outside-recording'
          ? 'Outside recording'
          : 'Untimed; no video timestamp';
    const row = capture?.ac ? byClaim.get(capture.ac) : undefined;
    if (capture?.role && row && !invalid) row[capture.role] = [...row[capture.role], candidate];
    else {
      candidate.limitation ??= 'No recorded AC and role binding';
      unassigned.push(candidate);
    }
    media.push(candidate);
  }
  const paths = new Set(media.map((entry) => entry.artifactPath));
  for (const artifact of inventory) {
    if (paths.has(artifact.path)) continue;
    const type =
      artifact.type === 'screenshot' || /\.(?:png|jpe?g|webp|gif|svg)$/iu.test(artifact.path)
        ? 'image'
        : artifact.type === 'video' || /\.(?:mp4|mov|webm|m4v)$/iu.test(artifact.path)
          ? 'video'
          : undefined;
    if (!type) continue;
    const candidate: EvidenceReviewComparisonMedia = {
      path: artifact.path,
      artifactPath: artifact.path,
      originalPath: artifact.path,
      name: artifact.label ?? artifact.path,
      identity: `unbound:${artifact.path}`,
      mediaType: type,
      clips: [],
      timing: 'untimed',
      eligible: false,
      limitation: 'No recorded AC and role binding',
    };
    unassigned.push(candidate);
    media.push(candidate);
  }
  const sort = (items: readonly EvidenceReviewComparisonMedia[]) =>
    [...items].sort(
      (a, b) =>
        (a.capture?.traceIndex ?? Infinity) - (b.capture?.traceIndex ?? Infinity) ||
        a.artifactPath.localeCompare(b.artifactPath),
    );
  for (const row of rows) {
    row.before = sort(row.before);
    row.after = sort(row.after);
    row.review = sort(row.review);
    const before = row.before.filter((entry) => entry.eligible);
    const after = row.after.filter((entry) => entry.eligible);
    if (before.length === 1) row.selectedBefore = before[0];
    if (after.length === 1) row.selectedAfter = after[0];
  }
  return { rows, unassigned: sort(unassigned), media };
}

export function matchesComparisonFilter(
  media: EvidenceReviewComparisonMedia,
  filter: EvidenceReviewComparisonFilter,
): boolean {
  if (filter === 'screenshots') return media.mediaType === 'image';
  if (filter === 'moments') return media.clips.length > 0;
  if (filter === 'before' || filter === 'after' || filter === 'review')
    return media.capture?.role === filter;
  return true;
}

export function normalizedComparisonTransform(
  value: EvidenceReviewComparisonTransform,
): EvidenceReviewComparisonTransform {
  const clamp = (number: number, min: number, max: number) => Math.max(min, Math.min(max, number));
  return {
    scale: Number.isFinite(value.scale) ? clamp(value.scale, 1, 4) : 1,
    x: Number.isFinite(value.x) ? clamp(value.x, 0, 1) : 0.5,
    y: Number.isFinite(value.y) ? clamp(value.y, 0, 1) : 0.5,
  };
}
