import type {
  RecipeRecordingMarker,
  RecipeRecordingTimelineDocument,
  RecordingSegmentRef,
} from '@farmslot/protocol';

export type RecipeRecordingMarkerLookup = (
  timeline: RecipeRecordingTimelineDocument,
  traceIndex: number,
) => RecipeRecordingMarker | undefined;

export interface OccurrenceRecordingCoverage {
  timing: 'measured' | 'untimed' | 'outside-recording';
  segments: RecordingSegmentRef[];
}

/** Equal video bytes can have different original-segment clocks. Paths identify those originals. */
export function indexRecordingTimelines(
  timelines: Iterable<RecipeRecordingTimelineDocument>,
): ReadonlyMap<string, RecipeRecordingTimelineDocument> {
  return new Map([...timelines].map((timeline) => [timeline.videoPath, timeline]));
}

/** Reuse measured ranges and ordered originals. A gap never becomes seekable proof. */
export function occurrenceRecordingCoverage(
  traceIndex: number,
  segments: readonly RecordingSegmentRef[],
  timelines?: ReadonlyMap<string, RecipeRecordingTimelineDocument>,
  markerLookup?: RecipeRecordingMarkerLookup,
): OccurrenceRecordingCoverage {
  const spans = segments.flatMap((segment, index) => {
    const timeline = timelines?.get(segment.videoPath);
    const marker = timeline
      ? markerLookup
        ? markerLookup(timeline, traceIndex)
        : timeline.markers.find((entry) => entry.traceIndex === traceIndex)
      : undefined;
    return timeline &&
      marker &&
      marker.endRangeMs[1] >= 0 &&
      marker.startRangeMs[0] <= timeline.durationMs
      ? [{ segment, index, timeline, marker }]
      : [];
  });
  const first = spans[0];
  const last = spans.at(-1);
  if (
    first &&
    last &&
    first.marker.startRangeMs[0] >= 0 &&
    last.marker.endRangeMs[1] <= last.timeline.durationMs &&
    spans.every(
      (span, index) =>
        index === 0 || (!span.segment.gapBefore && span.index === spans[index - 1]!.index + 1),
    )
  )
    return { timing: 'measured', segments: spans.map((span) => span.segment) };
  const untimed = segments.filter((segment) => !timelines?.has(segment.videoPath));
  return untimed.length
    ? { timing: 'untimed', segments: untimed }
    : { timing: 'outside-recording', segments: [] };
}
