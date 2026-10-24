import {
  extractRunArtifactManifest,
  isTerminalRunStatus,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TerminalSendParams,
} from '@farmslot/protocol';
import { type GatewayResourceCache, resourceQuery } from '@farmslot/protocol/client-cache';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactSource,
  artifactUrl,
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
  sendWorkerMessage(params: TerminalSendParams, expectedRun: Run): Promise<void>;
}

export interface VisualReviewResources {
  cache: Pick<GatewayResourceCache, 'read'>;
  sourceRunId: string;
  /** The selected owner and exact connection must still own this port. */
  current(): boolean;
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

export interface VisualReviewConnection {
  gatewayUrl: string;
  authHeaders: ArtifactHttpHeaders;
  profileId?: string;
}

export function visualReviewConnectionId({
  gatewayUrl,
  authHeaders,
  profileId = '',
}: VisualReviewConnection): string {
  return `${profileId}|${gatewayUrl}|${credentialFingerprint(authHeaders)}`;
}

/**
 * `liveConnection` reads the connection the shared client is switching to. The store updates it
 * before the client reconnects, so every request is refused once it no longer matches, even
 * before the screen rebinds.
 */
export function createVisualReviewGateway(
  client: Pick<GatewayClient, 'request'>,
  connection: VisualReviewConnection,
  resources: VisualReviewResources,
  liveConnection: () => VisualReviewConnection = () => connection,
): VisualReviewGateway {
  const { gatewayUrl, authHeaders } = connection;
  const connectionId = visualReviewConnectionId(connection);
  const assertCurrent = () => {
    if (!resources.current() || visualReviewConnectionId(liveConnection()) !== connectionId)
      throw new Error('The gateway connection changed. Reopen the review to continue.');
  };
  const readRun = (runId: string): Run => {
    assertCurrent();
    const state = resources.cache.read(resourceQuery<RunGetResult>(Methods.RUN_GET, { runId }));
    if (state.status !== 'ready' || state.data?.run.id !== runId)
      throw new Error('Wait for the current visual review run before acting.');
    return state.data.run;
  };
  const readRecipes = (runId: string): RunRecipeRunsForRunResult => {
    assertCurrent();
    const state = resources.cache.read(
      resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, { runId }),
    );
    if (state.status !== 'ready' || !state.data)
      throw new Error('Wait for current visual review evidence before acting.');
    return state.data;
  };
  const urlFor = (runId: string, artifact: VisualReviewArtifactRef) =>
    artifactUrl(gatewayUrl, runId, artifact.path, artifact.recipeRunId);
  return {
    connectionId,
    async getRun(runId) {
      return readRun(runId);
    },
    async listRunArtifacts(run) {
      if (readRun(run.id) !== run)
        throw new Error('The visual review run changed. Retry its source.');
      const { recipeRuns } = readRecipes(run.id);
      return [
        ...extractRunArtifactManifest(run),
        ...recipeRuns.flatMap((group: RecipeRunArtifactGroup) => artifactsForRecipeRun(group)),
      ];
    },
    async readArtifactText(runId, artifact) {
      assertCurrent();
      const response = await gatewayFetch(urlFor(runId, artifact), authHeaders);
      assertCurrent();
      if (!response.ok) throw new Error(`${artifact.path}: HTTP ${response.status}`);
      const text = await response.text();
      assertCurrent();
      return text;
    },
    imageSource(runId, artifact) {
      return artifactSource(urlFor(runId, artifact), authHeaders);
    },
    async sendWorkerMessage(params, expectedRun) {
      readRun(resources.sourceRunId);
      readRecipes(resources.sourceRunId);
      const run = readRun(expectedRun.id);
      if (run !== expectedRun || run.id !== params.runId || run.slotId !== params.slotId)
        throw new Error('The feedback target changed. Review it again before sending.');
      if (!run.slotId || isTerminalRunStatus(run.status))
        throw new Error('This run no longer accepts worker feedback.');
      await client.request(Methods.TERMINAL_SEND, params);
      assertCurrent();
    },
  };
}
