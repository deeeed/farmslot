import type { ArtifactRef, PublicationTarget, ReadyGatePayload } from '@farmslot/protocol';

import { VIDEO_EXTS } from './workspace-artifacts.js';

export function readyPublicationTargetKey(input: {
  decisionId?: string;
  payload: ReadyGatePayload;
}): string {
  const { payload } = input;
  return `${input.decisionId ?? ''}:${payload.prPackage?.packageHash ?? ''}:${payload.publicationTarget ?? payload.prPackage?.publicationTarget ?? ''}`;
}

export function readyPublicationTarget(payload: ReadyGatePayload): PublicationTarget {
  const existingTarget = payload.publicationTarget ?? payload.prPackage?.publicationTarget;
  return existingTarget === 'draft' || existingTarget === 'ready' ? existingTarget : 'ready';
}

export function readyEvidenceSelectionKey(input: {
  decisionId?: string;
  payload: ReadyGatePayload;
}): string {
  return `${input.decisionId ?? ''}:${input.payload.prPackage?.packageHash ?? ''}`;
}

export function initialReadyEvidenceSelection(
  payload: ReadyGatePayload,
  candidateKeys: string[],
): string[] {
  return [
    ...new Set(
      (payload.prPackage?.selectedEvidenceKeys ?? candidateKeys).filter((path) =>
        candidateKeys.includes(path),
      ),
    ),
  ];
}

export function readyPublishEvidenceSet(
  selectedEvidenceKeys: string[] | null,
  candidateKeys: string[],
): Set<string> {
  return new Set(selectedEvidenceKeys ?? candidateKeys);
}

export function setReadyEvidenceIncluded(input: {
  selectedEvidenceKeys: string[] | null;
  candidateKeys: string[];
  artifactPath: string;
  included: boolean;
}): string[] {
  const selected = readyPublishEvidenceSet(input.selectedEvidenceKeys, input.candidateKeys);
  if (input.included) selected.add(input.artifactPath);
  else selected.delete(input.artifactPath);
  return input.candidateKeys.filter((path) => selected.has(path));
}

export function setAllReadyEvidenceIncluded(candidateKeys: string[], included: boolean): string[] {
  return included ? candidateKeys : [];
}

export function excludeReadyEvidenceVideos(input: {
  selectedEvidenceKeys: string[] | null;
  candidates: ArtifactRef[];
}): string[] {
  const candidateKeys = input.candidates.map((entry) => entry.path);
  const selected = readyPublishEvidenceSet(input.selectedEvidenceKeys, candidateKeys);
  for (const artifact of input.candidates) {
    if (VIDEO_EXTS.test(artifact.path)) selected.delete(artifact.path);
  }
  return candidateKeys.filter((path) => selected.has(path));
}

export function selectedReadyEvidenceKeysForSubmit(
  selectedEvidenceKeys: string[] | null,
  candidateKeys: string[],
): string[] {
  return selectedEvidenceKeys ?? candidateKeys;
}
