import type { RecipeRecordingMarker } from '@farmslot/protocol';

import type { EvidenceReviewModel } from './evidence-review-model.js';
import { formatEvidenceReviewVideoTime } from './evidence-review-timeline.js';

type TimelineModel = Pick<
  EvidenceReviewModel,
  'recordingTimelineForPath' | 'currentOccurrences' | 'markerSeekMs' | 'errors'
>;

export interface EvidenceReviewerTimelineRow {
  traceIndex: number;
  intent: string;
  ok: boolean;
  atMs: number | null;
  timeLabel: string;
}

export interface EvidenceReviewerTimeline {
  stepCount: number;
  revision?: string;
  page(
    offset: number,
    limit: number,
    model?: TimelineModel,
    durationMs?: number,
  ): readonly EvidenceReviewerTimelineRow[];
}

type TimelineStep = Pick<EvidenceReviewerTimelineRow, 'traceIndex' | 'intent' | 'ok'>;

const emptyTrace: readonly TimelineStep[] = [];
interface OrderedTrace {
  ordered: readonly TimelineStep[];
  steps: ReadonlyMap<number, TimelineStep>;
}

const orderedTraces = new WeakMap<readonly TimelineStep[], OrderedTrace>();

function orderedTimelineTrace(occurrences: readonly TimelineStep[]): OrderedTrace {
  let trace = orderedTraces.get(occurrences);
  if (!trace) {
    const steps = new Map<number, TimelineStep>();
    for (const { traceIndex, intent, ok } of occurrences)
      steps.set(traceIndex, { traceIndex, intent, ok });
    const ordered = [...steps.values()].sort((a, b) => a.traceIndex - b.traceIndex);
    trace = { ordered, steps };
    orderedTraces.set(occurrences, trace);
  }
  return trace;
}

function lowerBound(length: number, before: (index: number) => boolean): number {
  let start = 0;
  let end = length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (before(middle)) start = middle + 1;
    else end = middle;
  }
  return start;
}

const timelineIndexes = new WeakMap<TimelineModel, Map<string, EvidenceReviewerTimeline>>();

export function evidenceReviewerTimeline(
  model: TimelineModel,
  path: string,
  previousProjection?: EvidenceReviewerTimeline,
  allowHistorical = false,
): EvidenceReviewerTimeline | undefined {
  const key = JSON.stringify([path, allowHistorical]);
  const known = timelineIndexes.get(model)?.get(key);
  if (known) return known;
  const source = model.recordingTimelineForPath(path, { allowHistorical });
  if (!source || (model.errors.length && !source.historicalSeekMs)) return undefined;
  const { timeline, current, sidecarDigest: sidecar } = source;
  const videoDigest = source.videoDigest ?? timeline?.videoDigest;
  const traceDigest = source.traceDigest ?? timeline?.traceDigest;
  const revision =
    videoDigest && traceDigest && (!timeline || sidecar)
      ? JSON.stringify([key, videoDigest, traceDigest, sidecar, current])
      : undefined;
  const indexes = timelineIndexes.get(model) ?? new Map<string, EvidenceReviewerTimeline>();
  timelineIndexes.set(model, indexes);
  if (revision && previousProjection?.revision === revision) {
    indexes.set(key, previousProjection);
    return previousProjection;
  }

  const occurrences = current ? model.currentOccurrences : source.retainedOccurrences;
  const { ordered, steps } = orderedTimelineTrace(occurrences ?? emptyTrace);
  const markers = new Map<number, RecipeRecordingMarker>();
  for (const marker of timeline?.markers ?? []) markers.set(marker.traceIndex, marker);

  // Older sidecars can outlive their trace. Keep just their extra rows and where they join it.
  const extra: Array<{ position: number; step: TimelineStep }> = [];
  for (const { traceIndex, intent, nodeId, ok } of markers.values()) {
    if (steps.has(traceIndex)) continue;
    const position = lowerBound(ordered.length, (i) => ordered[i]!.traceIndex < traceIndex);
    extra.push({ position, step: { traceIndex, intent: intent ?? nodeId, ok } });
  }
  extra.sort((a, b) => a.step.traceIndex - b.step.traceIndex);
  for (const [i, row] of extra.entries()) row.position += i;
  const stepCount = ordered.length + extra.length;
  let previous:
    | {
        model: TimelineModel;
        offset: number;
        limit: number;
        durationMs?: number;
        rows: EvidenceReviewerTimelineRow[];
      }
    | undefined;
  const index: EvidenceReviewerTimeline = {
    stepCount,
    revision,
    page(offset, limit, currentModel = model, durationMs) {
      if (
        previous?.model === currentModel &&
        previous.offset === offset &&
        previous.limit === limit &&
        previous.durationMs === durationMs
      )
        return previous.rows;
      const historicalSeek = source.historicalSeekMs
        ? currentModel.recordingTimelineForPath(path, { allowHistorical })?.historicalSeekMs
        : undefined;
      const rows: EvidenceReviewerTimelineRow[] = [];
      let extraIndex = lowerBound(extra.length, (i) => extra[i]!.position < offset);
      for (let i = offset; i < Math.min(stepCount, offset + limit); i++) {
        const entry = extra[extraIndex];
        const step = entry?.position === i ? entry.step : ordered[i - extraIndex]!;
        if (entry?.position === i) extraIndex++;
        const { traceIndex } = step;
        const marker = markers.get(traceIndex);
        const atMs =
          marker && timeline
            ? historicalSeek
              ? historicalSeek(traceIndex, durationMs)
              : currentModel.markerSeekMs(timeline.videoPath, traceIndex, 'start', durationMs)
            : null;
        const timeLabel =
          atMs !== null
            ? formatEvidenceReviewVideoTime(atMs / 1000, false)
            : marker && timeline && marker.endRangeMs[1] < (timeline.framesMs[0] ?? 0)
              ? 'Before recording'
              : marker && timeline && marker.startRangeMs[0] >= timeline.durationMs
                ? 'After recording'
                : 'Time unavailable';
        rows.push({
          traceIndex,
          intent: marker ? (marker.intent ?? marker.nodeId) : step.intent,
          ok: marker?.ok ?? step.ok,
          atMs,
          timeLabel,
        });
      }
      previous = { model: currentModel, offset, limit, durationMs, rows };
      return rows;
    },
  };
  indexes.set(key, index);
  return index;
}

/** The serialized seek is a millisecond; secondary precision comes from media metadata. */
export function restoreRecordingTimeMs(atMs: number, durationMs: number): number | null {
  if (!Number.isFinite(atMs) || atMs < 0 || atMs > Math.round(durationMs)) return null;
  return Math.min(atMs, durationMs);
}

/** A mutable artifact path needs verified bytes and, when available, trace identity. */
export function evidenceRecordingRevision(
  model: EvidenceReviewModel,
  path?: string,
): string | undefined {
  if (!path) return undefined;
  const recording = model.recordingForPath(path);
  return recording?.videoDigest
    ? [
        recording.videoDigest,
        recording.timelineDigest ??
          model.recordingTimelineForPath(path, { allowHistorical: true })?.traceDigest,
      ]
        .filter(Boolean)
        .join('.')
    : undefined;
}
