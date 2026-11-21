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

interface RecordingSpan {
  segment: RecordingSegmentRef;
  index: number;
  timeline: RecipeRecordingTimelineDocument;
  marker: RecipeRecordingMarker;
}

function coverageFromSpans(
  spans: readonly RecordingSpan[],
  getUntimed: () => RecordingSegmentRef[],
): OccurrenceRecordingCoverage {
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
  const untimed = getUntimed();
  return untimed.length
    ? { timing: 'untimed', segments: untimed }
    : { timing: 'outside-recording', segments: [] };
}

function overlapsRecording(
  marker: RecipeRecordingMarker,
  timeline: RecipeRecordingTimelineDocument,
) {
  return marker.endRangeMs[1] >= 0 && marker.startRangeMs[0] <= timeline.durationMs;
}

/** Index the spans once for callers projecting many occurrences from an immutable source. */
export function indexOccurrenceRecordingCoverage(
  segments: readonly RecordingSegmentRef[],
  timelines: ReadonlyMap<string, RecipeRecordingTimelineDocument>,
): (traceIndex: number) => OccurrenceRecordingCoverage {
  const byOccurrence = new Map<number, RecordingSpan[]>();
  const untimed: RecordingSegmentRef[] = [];
  for (const [index, segment] of segments.entries()) {
    const timeline = timelines.get(segment.videoPath);
    if (!timeline) {
      untimed.push(segment);
      continue;
    }
    for (const marker of timeline.markers) {
      if (!overlapsRecording(marker, timeline)) continue;
      const spans = byOccurrence.get(marker.traceIndex) ?? [];
      spans.push({ segment, index, timeline, marker });
      byOccurrence.set(marker.traceIndex, spans);
    }
  }
  const getUntimed = () => untimed;
  const outside = coverageFromSpans([], getUntimed);
  const indexed = new Map(
    [...byOccurrence].map(([traceIndex, spans]) => [
      traceIndex,
      coverageFromSpans(spans, getUntimed),
    ]),
  );
  return (traceIndex) => indexed.get(traceIndex) ?? outside;
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
    return timeline && marker && overlapsRecording(marker, timeline)
      ? [{ segment, index, timeline, marker }]
      : [];
  });
  return coverageFromSpans(spans, () =>
    segments.filter((segment) => !timelines?.has(segment.videoPath)),
  );
}
