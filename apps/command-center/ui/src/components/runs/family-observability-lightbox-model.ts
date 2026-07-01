import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import type { LightboxPair } from '../shared/media-lightbox-types.js';

import { familyLightboxItem } from './family-observability-artifact-model.js';
import { buildFamilyLightboxPairs } from './family-observability-evidence.js';

export function selectedFamilyRun(
  snapshot: FamilyObservabilitySnapshot | null,
  selectedRunId: string,
): FamilyObservabilityRunSummary | null {
  if (!snapshot) return null;
  return snapshot.runs.find((run) => run.runId === selectedRunId) ?? snapshot.runs[0] ?? null;
}

export function familyRunForArtifact(
  snapshot: FamilyObservabilitySnapshot | null,
  artifact: FamilyObservabilityArtifact,
): FamilyObservabilityRunSummary | null {
  const runs = snapshot?.runs ?? [];
  const sourceRunId = artifact.sourceRunId ?? artifact.runId;
  return (
    runs.find((run) => run.runId === sourceRunId) ??
    runs.find((run) => run.runId === artifact.runId) ??
    null
  );
}

export function familyVisibleLightboxArtifacts(
  overrideArtifacts: readonly FamilyObservabilityArtifact[] | null,
  visibleEvidenceArtifacts: readonly FamilyObservabilityArtifact[],
): FamilyObservabilityArtifact[] {
  return overrideArtifacts ? [...overrideArtifacts] : [...visibleEvidenceArtifacts];
}

export function familyLightboxItemsForArtifacts(
  artifacts: readonly FamilyObservabilityArtifact[],
  snapshot: FamilyObservabilitySnapshot | null,
) {
  return artifacts.map((artifact) =>
    familyLightboxItem(artifact, familyRunForArtifact(snapshot, artifact)),
  );
}

export function familyLightboxPairsForSnapshot(
  snapshot: FamilyObservabilitySnapshot | null,
): LightboxPair[] {
  return buildFamilyLightboxPairs(snapshot?.evidence ?? [], (artifact) =>
    familyLightboxItem(artifact, familyRunForArtifact(snapshot, artifact)),
  );
}

export function familyLightboxPairForArtifact(
  pairs: readonly LightboxPair[],
  artifact: FamilyObservabilityArtifact,
): { index: number } | null {
  const target = artifact.path;
  const index = pairs.findIndex(
    (pair) => pair.before.path === target || pair.after.path === target,
  );
  return index >= 0 ? { index } : null;
}
