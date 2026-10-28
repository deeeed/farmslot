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
