import {
  type InteractiveOperatorPacketActionRequest,
  interactiveOperatorPacketActionRequest,
  interactiveOperatorPacketArtifacts,
  type Run,
} from '@farmslot/protocol';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactUrl,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
} from './artifact-url';
import { gatewayResourceUrl } from './gateway-http-auth';

export type PacketActionRequest = InteractiveOperatorPacketActionRequest;
export const interactivePacketActionRequest = interactiveOperatorPacketActionRequest;

export function collectRunInteractivePacketArtifacts(run: Run): ArtifactManifestEntry[] {
  return interactiveOperatorPacketArtifacts(extractRunArtifactManifest(run));
}

export function interactivePacketArtifactKey(artifacts: readonly ArtifactManifestEntry[]): string {
  return artifacts.map(interactivePacketArtifactKeyPart).join('\n');
}

export function interactivePacketArtifactOpenUrl(
  gatewayUrl: string,
  runId: string,
  artifactPath: string,
  artifactAuthHeaders: ArtifactHttpHeaders,
): string {
  return gatewayResourceUrl(artifactUrl(gatewayUrl, runId, artifactPath), artifactAuthHeaders);
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

/** Packet links select an ordinary task artifact without inventing an acceptance criterion. */
export function interactivePacketArtifactViewerHref(runId: string, path: string) {
  return {
    pathname: '/evidence/[runId]' as const,
    params: { runId, artifact: path, recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM },
  };
}
