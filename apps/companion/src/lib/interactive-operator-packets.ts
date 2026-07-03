import {
  type InteractiveOperatorPacketActionRequest,
  interactiveOperatorPacketActionRequest,
  interactiveOperatorPacketArtifacts,
  type Run,
} from '@farmslot/protocol';

import { type ArtifactManifestEntry, extractRunArtifactManifest } from './artifact-url';

export type PacketActionRequest = InteractiveOperatorPacketActionRequest;
export const interactivePacketActionRequest = interactiveOperatorPacketActionRequest;

export function collectRunInteractivePacketArtifacts(run: Run): ArtifactManifestEntry[] {
  return interactiveOperatorPacketArtifacts(extractRunArtifactManifest(run));
}

export function interactivePacketArtifactKey(artifacts: readonly ArtifactManifestEntry[]): string {
  return artifacts.map(interactivePacketArtifactKeyPart).join('\n');
}

function interactivePacketArtifactKeyPart(artifact: ArtifactManifestEntry): string {
  return [
    artifact.path,
    artifact.purpose,
    artifact.type ?? '',
    artifact.mimeType ?? '',
    artifact.sizeBytes == null ? '' : String(artifact.sizeBytes),
  ].join('\u001f');
}
