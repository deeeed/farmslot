import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  type ArtifactRef,
  dedupeRunArtifacts,
  inferRunArtifactPurpose,
  isRunArtifactImagePath,
  isRunEvidenceVideoArtifact,
  type RecipeRunArtifactGroup,
  withArtifactBundleDigest,
} from '@farmslot/protocol';

import type { EvidenceMediaLookup } from './evidence-media';
import { type GatewayHttpAuthHeaders, gatewayResourceSource } from './gateway-http-auth';

export const DECISION_EVIDENCE_RECIPE_RUN_PARAM = 'decision-evidence';
export const CURRENT_ARTIFACTS_RECIPE_RUN_PARAM = 'current-artifacts';

export type ArtifactHttpHeaders = GatewayHttpAuthHeaders;

let heldMedia: EvidenceMediaLookup | undefined;

/** The resource cache registers where its scope's held gate evidence lives on the device. */
export function setHeldArtifactLookup(lookup: EvidenceMediaLookup | undefined): void {
  heldMedia = lookup;
}

/** A held file by artifact digest, for readers that know the manifest's sha256. */
export function heldArtifactFile(sha256: string): string | undefined {
  return heldMedia?.byDigest(sha256);
}

/** A run artifact the device holds for exactly this package: run, path and bundle digest. */
function heldArtifactUri(uri: string): string | undefined {
  const query = heldMedia && uri.includes('/api/run-artifact?') ? uri.split('?')[1] : undefined;
  if (!query) return undefined;
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    const [name, value = ''] = pair.split('=');
    params.set(decodeURIComponent(name), decodeURIComponent(value.replace(/\+/g, ' ')));
  }
  const runId = params.get('runId');
  const path = params.get('path');
  if (!runId || !path || params.get('recipeRunId')) return undefined;
  return heldMedia?.byPath(runId, path, params.get('bundleDigest'));
}

/** Held evidence is read from the device, silently; anything else from the gateway. */
export function artifactSource(
  uri: string,
  headers: ArtifactHttpHeaders = {},
): { uri: string; headers?: ArtifactHttpHeaders } {
  const held = heldArtifactUri(uri);
  return held ? { uri: held } : gatewayResourceSource(uri, headers);
}

export type ArtifactManifestType =
  | 'screenshot'
  | 'image'
  | 'video'
  | 'log'
  | 'trace'
  | 'summary'
  | 'json'
  | 'report'
  | 'metric'
  | 'diff'
  | 'recipe'
  | 'other'
  | (string & {});

export interface ArtifactManifestEntry extends Pick<
  ArtifactRef,
  'sha256' | 'timelinePath' | 'timelineUnavailableReason' | 'bundleDigest'
> {
  path: string;
  purpose: string;
  sizeBytes?: number;
  type?: ArtifactManifestType;
  label?: string;
  nodeId?: string;
  mimeType?: string;
  recipeRunId?: string;
  sourceLabel?: string;
  sourceStatus?: RecipeRunArtifactGroup['status'];
}

export interface VisualArtifactPair<T extends ArtifactManifestEntry = ArtifactManifestEntry> {
  before: T & { url: string };
  after: T & { url: string };
  stem: string;
}

/**
 * Build an HTTP URL for a run artifact served by the gateway.
 * Derives the HTTP base from the WebSocket URL stored in the connection store.
 */
export function artifactUrl(
  gatewayWsUrl: string,
  runId: string,
  path: string,
  recipeRunId?: string | null,
  mirrorEpoch?: number,
  bundleDigest?: string,
): string {
  const base = wsToHttpBase(gatewayWsUrl);
  const params = new URLSearchParams({ runId, path });
  if (recipeRunId) params.set('recipeRunId', recipeRunId);
  if (mirrorEpoch && mirrorEpoch > 0) params.set('m', String(mirrorEpoch));
  return withArtifactBundleDigest(`${base}/api/run-artifact?${params.toString()}`, bundleDigest);
}

export function artifactUrlForEntry(
  gatewayWsUrl: string,
  runId: string,
  artifact: ArtifactManifestEntry,
  mirrorEpoch?: number,
): string {
  return artifactUrl(
    gatewayWsUrl,
    runId,
    artifact.path,
    artifact.recipeRunId,
    mirrorEpoch,
    artifact.bundleDigest,
  );
}

export function artifactsForRecipeRun(group: RecipeRunArtifactGroup): ArtifactManifestEntry[] {
  const recipeRunId = group.groupKind === CURRENT_ARTIFACTS_RECIPE_RUN_PARAM ? undefined : group.id;
  return dedupeRunArtifacts(
    (group.artifactManifest ?? []).map((artifact) => ({
      ...artifact,
      recipeRunId,
      sourceLabel: group.label,
      sourceStatus: group.status,
    })),
  );
}

export function resolveRecipeRunSelection(
  groups: Array<Pick<RecipeRunArtifactGroup, 'id'>>,
  requestedId: string | null | undefined,
  fallbackId: string | null | undefined,
): string | null {
  if (requestedId && groups.some((group) => group.id === requestedId)) return requestedId;
  if (fallbackId && groups.some((group) => group.id === fallbackId)) return fallbackId;
  return groups[0]?.id ?? null;
}

function wsToHttpBase(wsUrl: string): string {
  let url = wsUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
  // Strip trailing /ws path
  url = url.replace(/\/ws\/?$/, '');
  // Strip trailing slash
  url = url.replace(/\/$/, '');
  return url;
}

const DOC_EXTS = /\.(md|txt|json|log)$/i;
export type ArtifactMediaType = 'image' | 'video' | 'document' | 'other';

export function classifyArtifact(
  pathOrArtifact: string | ArtifactManifestEntry,
): ArtifactMediaType {
  const artifact =
    typeof pathOrArtifact === 'string'
      ? { path: pathOrArtifact, purpose: inferRunArtifactPurpose(pathOrArtifact) }
      : pathOrArtifact;
  const path = artifact.path;
  const type = artifact.type?.toLowerCase();
  const mimeType = artifact.mimeType?.toLowerCase();
  const purpose = artifact.purpose?.toLowerCase();
  if (DOC_EXTS.test(path)) return 'document';
  if (type === 'screenshot' || type === 'image') return 'image';
  if (type === 'video') return 'video';
  if (
    type === 'log' ||
    type === 'trace' ||
    type === 'summary' ||
    type === 'json' ||
    type === 'report' ||
    type === 'metric' ||
    type === 'diff' ||
    type === 'recipe'
  ) {
    return 'document';
  }
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('text/') || mimeType === 'application/json') {
    return 'document';
  }
  if (purpose === 'screenshot' || purpose === 'image') return 'image';
  if (purpose === 'video') return 'video';
  if (isRunArtifactImagePath(path)) return 'image';
  if (isRunEvidenceVideoArtifact({ path })) return 'video';
  return 'other';
}

export function isBeforeVisualArtifact(
  artifact: { path: string; purpose?: string },
  model?: EvidenceReviewModel | null,
): boolean {
  return model?.artifactRole(artifact.path) === 'before';
}
export function isAfterVisualArtifact(
  artifact: { path: string; purpose?: string },
  model?: EvidenceReviewModel | null,
): boolean {
  return model?.artifactRole(artifact.path) === 'after';
}

export function isVisualMediaArtifact(artifact: ArtifactManifestEntry): boolean {
  const mediaType = classifyArtifact(artifact);
  return mediaType === 'image' || mediaType === 'video';
}

export function groupVisualArtifactPairs<T extends ArtifactManifestEntry>(
  manifest: T[],
  urlFor: (artifact: T) => string,
  model?: EvidenceReviewModel | null,
): { pairs: VisualArtifactPair<T>[]; singles: T[] } {
  const paired = new Set<T>();
  const pairs = (model?.pairedArtifacts(manifest) ?? []).map(({ before, after, claimId }) => {
    paired.add(before);
    paired.add(after);
    return {
      before: { ...before, url: urlFor(before) },
      after: { ...after, url: urlFor(after) },
      stem: claimId,
    };
  });
  return { pairs, singles: manifest.filter((artifact) => !paired.has(artifact)) };
}
export function countVisualArtifactPairs<T extends ArtifactManifestEntry>(
  manifest: T[],
  model?: EvidenceReviewModel | null,
): number {
  return model?.pairedArtifacts(manifest).length ?? 0;
}
export function deriveBaselineVisualArtifactPairs<T extends ArtifactManifestEntry>(
  manifest: T[],
  urlFor: (artifact: T) => string,
  existingPairs: Array<Pick<VisualArtifactPair<T>, 'before' | 'after'>> = [],
  model?: EvidenceReviewModel | null,
): VisualArtifactPair<T>[] {
  const existing = new Set(existingPairs.map((pair) => `${pair.before.path}::${pair.after.path}`));
  return groupVisualArtifactPairs(manifest, urlFor, model).pairs.filter(
    (pair) => !existing.has(`${pair.before.path}::${pair.after.path}`),
  );
}

export function visualArtifactPairStem(pair: {
  before: ArtifactManifestEntry;
  after: ArtifactManifestEntry;
}): string {
  return `${pair.before.label ?? pair.before.path} → ${pair.after.label ?? pair.after.path}`;
}

export function formatVisualArtifactPairLabel(
  pair: Pick<VisualArtifactPair, 'before' | 'after' | 'stem'>,
): string {
  const stem = pair.stem || visualArtifactPairStem(pair);
  if (/^ac\d+$/i.test(stem)) return stem.toUpperCase();
  return (
    stem
      .replace(/[-_.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || visualArtifactPairStem(pair)
  );
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes == null || bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
