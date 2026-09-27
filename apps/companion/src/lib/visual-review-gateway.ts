import {
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TerminalSendParams,
} from '@farmslot/protocol';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactSource,
  artifactUrl,
  extractRunArtifactManifest,
} from './artifact-url';
import type { GatewayClient } from './gateway-client';
import { gatewayFetch } from './gateway-http-auth';

export interface VisualReviewArtifactRef {
  path: string;
  recipeRunId?: string;
}

/**
 * Everything the visual review flow needs from a gateway, expressed through the existing run,
 * artifact, and runner-input contracts. Screens receive this port, never the client.
 */
export interface VisualReviewGateway {
  /**
   * Profile, URL, and credential fingerprint of the connection. A review is bound to the one it
   * was loaded from: replaced credentials may authenticate as another principal.
   */
  readonly connectionId: string;
  getRun(runId: string): Promise<Run>;
  /** Decision/step manifests plus every recipe-run group's entries, scoped by `recipeRunId`. */
  listRunArtifacts(run: Run): Promise<ArtifactManifestEntry[]>;
  readArtifactText(runId: string, artifact: VisualReviewArtifactRef): Promise<string>;
  imageSource(
    runId: string,
    artifact: VisualReviewArtifactRef,
  ): { uri: string; headers?: ArtifactHttpHeaders };
  /** Operator message into the run's worker input. Resolves once the gateway accepted it. */
  sendWorkerMessage(params: TerminalSendParams): Promise<void>;
}

/**
 * One-way fingerprint of the auth headers, so a connection identity can be compared without
 * keeping or printing the secret. Not a security boundary; the gateway still authenticates.
 */
export function credentialFingerprint(headers: ArtifactHttpHeaders): string {
  const text = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}:${value}`)
    .join('\n');
  // cyrb53: a 53-bit string hash, stable across runs and platforms.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function createVisualReviewGateway(
  client: Pick<GatewayClient, 'request'>,
  gatewayUrl: string,
  authHeaders: ArtifactHttpHeaders,
  profileId = '',
): VisualReviewGateway {
  const urlFor = (runId: string, artifact: VisualReviewArtifactRef) =>
    artifactUrl(gatewayUrl, runId, artifact.path, artifact.recipeRunId);
  return {
    connectionId: `${profileId}|${gatewayUrl}|${credentialFingerprint(authHeaders)}`,
    async getRun(runId) {
      return (await client.request<RunGetResult>(Methods.RUN_GET, { runId })).run;
    },
    async listRunArtifacts(run) {
      const { recipeRuns } = await client.request<RunRecipeRunsForRunResult>(
        Methods.RUN_RECIPE_RUNS_FOR_RUN,
        { runId: run.id },
      );
      return [
        ...extractRunArtifactManifest(run),
        ...recipeRuns.flatMap((group: RecipeRunArtifactGroup) => artifactsForRecipeRun(group)),
      ];
    },
    async readArtifactText(runId, artifact) {
      const response = await gatewayFetch(urlFor(runId, artifact), authHeaders);
      if (!response.ok) throw new Error(`${artifact.path}: HTTP ${response.status}`);
      return response.text();
    },
    imageSource(runId, artifact) {
      return artifactSource(urlFor(runId, artifact), authHeaders);
    },
    async sendWorkerMessage(params) {
      await client.request(Methods.TERMINAL_SEND, params);
    },
  };
}
