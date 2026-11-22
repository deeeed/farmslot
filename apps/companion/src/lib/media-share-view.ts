import type {
  CompanionViewLocation,
  SharedRunArtifactSelection,
} from '@farmslot/protocol/surfaces/view-links';

/** The opening artifact cannot stand in for a subsequently chosen recording or occurrence. */
export function mediaShareView(
  artifact: SharedRunArtifactSelection | undefined,
  selectionChanged: boolean,
): CompanionViewLocation | undefined {
  if (selectionChanged)
    return {
      pathname: '/unmapped-overlay',
      params: {},
      unavailableMessage:
        'Web link unavailable: this selected recording or occurrence has no exact Command Center view.',
    };
  return artifact
    ? {
        pathname: '/artifacts',
        params: { runId: artifact.runId, artifact: artifact.path, recipeRun: artifact.recipeRunId },
        artifactSelection: artifact,
      }
    : undefined;
}

export interface RecordingAnchor {
  requestedMs: number;
  previousMs: number;
  observedMs?: number;
}

/** Old samples can precede seek completion; a third position means playback has moved. */
export function observeRecordingAnchor(
  anchor: RecordingAnchor,
  playing: boolean,
  positionMs: number,
): 'pending' | 'confirmed' | 'moved' {
  if (playing) return 'moved';
  if (anchor.observedMs !== undefined)
    return Math.abs(positionMs - anchor.observedMs) <= 1 ? 'confirmed' : 'moved';
  // A short seek can leave a queued old sample inside the landing tolerance.
  if (
    Math.abs(positionMs - anchor.previousMs) <= 1 &&
    Math.round(positionMs) !== Math.round(anchor.requestedMs)
  )
    return 'pending';
  return Math.abs(positionMs - anchor.requestedMs) <= 100 ? 'confirmed' : 'moved';
}
