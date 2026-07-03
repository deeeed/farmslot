import type { ArtifactRef, InteractiveOperatorPacketActionRequest } from '@farmslot/protocol';
import {
  interactiveOperatorPacketActionRequest,
  interactiveOperatorPacketArtifacts,
} from '@farmslot/protocol';

export type PacketActionRequest = InteractiveOperatorPacketActionRequest;
export const interactivePacketActionRequest = interactiveOperatorPacketActionRequest;

export function collectInteractivePacketArtifacts(
  artifacts: readonly ArtifactRef[],
): ArtifactRef[] {
  return interactiveOperatorPacketArtifacts(artifacts);
}

export function interactivePacketArtifactKey(artifacts: readonly ArtifactRef[]): string {
  return artifacts.map(interactivePacketArtifactKeyPart).join('\n');
}

function interactivePacketArtifactKeyPart(artifact: ArtifactRef): string {
  return [
    artifact.path,
    artifact.purpose,
    artifact.type ?? '',
    artifact.mimeType ?? '',
    artifact.sha256 ?? '',
    artifact.sizeBytes == null ? '' : String(artifact.sizeBytes),
  ].join('\u001f');
}
