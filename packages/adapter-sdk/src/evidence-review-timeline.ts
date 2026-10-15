import type { RecipeRecordingMarker } from '@farmslot/protocol';

export interface EvidenceReviewTimelineGroup {
  id: string;
  label: string;
  claimId?: string;
  markers: readonly RecipeRecordingMarker[];
  passed: number;
  failed: number;
  unrecorded: number;
  defaultOpen: boolean;
  firstFailureTraceIndex: number | null;
  startMarker: RecipeRecordingMarker | null;
  endMarker: RecipeRecordingMarker | null;
  startMs: number | null;
  endMs: number | null;
  rangeLabel: string;
  summary: string;
}

interface TimelineGroupMarkers {
  id: string;
  label: string;
  claimId?: string;
  markers: RecipeRecordingMarker[];
}

export type EvidenceReviewMarkerSeek = (
  marker: RecipeRecordingMarker,
  phase: 'start' | 'end',
) => number | null;

/** The existing player timecode, also used for group ranges without hundredths. */
export function formatEvidenceReviewVideoTime(seconds: number, hundredths = true): string {
  if (!Number.isFinite(seconds) || seconds < 0) return hundredths ? '0:00.00' : '0:00';
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const time = `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
  return hundredths ? `${time}.${String(Math.floor((seconds % 1) * 100)).padStart(2, '0')}` : time;
}

/** Presentation only: bindings and outcomes come from the validated recording markers. */
export function evidenceReviewTimelineGroups(
  markers: readonly RecipeRecordingMarker[],
  seek: EvidenceReviewMarkerSeek,
  claimId?: string,
  belongsToClaim?: (marker: RecipeRecordingMarker) => boolean,
): EvidenceReviewTimelineGroup[] {
  const sorted = [...markers].sort(
    (a, b) => a.startRangeMs[0] - b.startRangeMs[0] || a.traceIndex - b.traceIndex,
  );
  const bound = markers
    .filter((marker) => marker.proves?.length)
    .map((marker) => marker.traceIndex);
  const first = bound.length ? Math.min(...bound) : null;
  const last = bound.length ? Math.max(...bound) : null;
  const groups = new Map<string, TimelineGroupMarkers>();
  for (const marker of sorted) {
    const bindings = [...new Set(marker.proves ?? [])];
    if (claimId && belongsToClaim?.(marker) && !bindings.includes(claimId)) bindings.push(claimId);
    const labels = bindings.length
      ? bindings
      : [
          first !== null && marker.traceIndex < first
            ? 'Setup'
            : last !== null && marker.traceIndex > last
              ? 'Teardown'
              : 'Other',
        ];
    for (const label of labels) {
      const id = bindings.length ? `claim:${label}` : `phase:${label}`;
      const group: TimelineGroupMarkers = groups.get(id) ?? {
        id,
        label,
        ...(bindings.length ? { claimId: label } : {}),
        markers: [],
      };
      group.markers.push(marker);
      groups.set(id, group);
    }
  }
  return [...groups.values()]
    .filter((group) => claimId === undefined || group.claimId === claimId)
    .map((group) => {
      const measured = group.markers.flatMap((marker) => {
        const start = seek(marker, 'start');
        const end = seek(marker, 'end');
        return start === null || end === null ? [] : [{ marker, start, end }];
      });
      const start = measured.reduce<(typeof measured)[number] | null>(
        (a, b) => (!a || b.start < a.start ? b : a),
        null,
      );
      const end = measured.reduce<(typeof measured)[number] | null>(
        (a, b) => (!a || b.end > a.end ? b : a),
        null,
      );
      const failed = group.markers.filter((marker) => !marker.ok).length;
      const passed = group.markers.length - failed;
      const unrecorded = group.markers.length - measured.length;
      const rangeLabel =
        start && end
          ? `${formatEvidenceReviewVideoTime(start.start / 1000, false)}–${formatEvidenceReviewVideoTime(end.end / 1000, false)}`
          : 'unrecorded';
      return {
        ...group,
        passed,
        failed,
        unrecorded,
        defaultOpen: failed > 0,
        firstFailureTraceIndex: group.markers.find((marker) => !marker.ok)?.traceIndex ?? null,
        startMarker: start?.marker ?? null,
        endMarker: end?.marker ?? null,
        startMs: start?.start ?? null,
        endMs: end?.end ?? null,
        rangeLabel,
        summary: `${group.label} · ${rangeLabel} · ${group.markers.length} ${group.markers.length === 1 ? 'check' : 'checks'} · ${passed} pass${failed ? ` · ${failed} fail` : ''}${unrecorded ? ` · ${unrecorded} unrecorded` : ''}`,
      };
    });
}
