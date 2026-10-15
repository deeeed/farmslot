import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  type ArtifactRef,
  isRunEvidenceVideoArtifact,
  type RecipeRunArtifactGroup,
  type Run,
  withArtifactBundleDigest,
} from '@farmslot/protocol';

import { type GatewayHttpAuthHeaders, gatewayResourceSource } from './gateway-http-auth';

export const DECISION_EVIDENCE_RECIPE_RUN_PARAM = 'decision-evidence';
export const CURRENT_ARTIFACTS_RECIPE_RUN_PARAM = 'current-artifacts';

export type ArtifactHttpHeaders = GatewayHttpAuthHeaders;

export function artifactSource(
  uri: string,
  headers: ArtifactHttpHeaders = {},
): { uri: string; headers?: ArtifactHttpHeaders } {
  return gatewayResourceSource(uri, headers);
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

/**
 * Pull the artifact manifest off a run's first ready-gate decision payload.
 * Returns [] when the run has no ready-gate or no manifest.
 */
export function extractArtifactManifest(run: Run): ArtifactManifestEntry[] {
  const entries: ArtifactManifestEntry[] = [];
  for (const d of run.decisions ?? []) {
    const payload = d.payload;
    if (payload?.kind === 'ready') {
      entries.push(...(payload.artifactManifest ?? []));
      entries.push(...(payload.prPackage?.evidenceManifest ?? []));
      for (const check of payload.prPackage?.deterministicChecks ?? []) {
        if (check.logPath) {
          entries.push({
            path: check.logPath,
            purpose: 'ci-parity-log',
            type: 'log',
            label: `${check.reference} · ${check.status}`,
          });
        }
      }
    } else if (payload?.kind === 'review') {
      entries.push(...(payload.artifactManifest ?? []));
      entries.push(...artifactPathsToManifest(payload.reviewInputArtifactPaths ?? []));
    } else if (payload?.kind === 'no-change') {
      entries.push(...(payload.artifactManifest ?? []));
    }
  }
  return dedupeArtifacts(entries);
}

export function extractRunArtifactManifest(run: Run): ArtifactManifestEntry[] {
  const entries = [...extractArtifactManifest(run)];
  for (const step of run.steps ?? []) {
    collectArtifactManifestEntries(step.outputs, entries);
  }
  return dedupeArtifacts(entries);
}

export function artifactsForRecipeRun(group: RecipeRunArtifactGroup): ArtifactManifestEntry[] {
  const recipeRunId = group.groupKind === CURRENT_ARTIFACTS_RECIPE_RUN_PARAM ? undefined : group.id;
  return dedupeArtifacts(
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

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|svg|webp)$/i;
const DOC_EXTS = /\.(md|txt|json|log)$/i;
const NEUTRAL_VISUAL_PURPOSES = new Set([
  'image',
  'screenshot',
  'debug-screenshot',
  'video',
  'visual',
]);

export type ArtifactMediaType = 'image' | 'video' | 'document' | 'other';

export function classifyArtifact(
  pathOrArtifact: string | ArtifactManifestEntry,
): ArtifactMediaType {
  const artifact =
    typeof pathOrArtifact === 'string'
      ? { path: pathOrArtifact, purpose: inferArtifactPurpose(pathOrArtifact) }
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
  if (IMAGE_EXTS.test(path)) return 'image';
  if (isRunEvidenceVideoArtifact({ path })) return 'video';
  return 'other';
}

export function inferArtifactPurpose(path: string): string {
  const normalized = path.toLowerCase();
  if (/\.(diff|patch)$/.test(normalized)) return 'diff';
  if (normalized.includes('screenshot')) return 'screenshot';
  if (isRunEvidenceVideoArtifact({ path })) return 'video';
  if (IMAGE_EXTS.test(path)) return 'image';
  if (/diff[_-]?stat/i.test(normalized)) return 'diff-stat';
  if (/\/diff\.(txt|md)$/i.test(normalized)) return 'diff';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('report')) return 'report';
  if (normalized.includes('recipe')) return 'recipe';
  return 'artifact';
}

function collectArtifactManifestEntries(value: unknown, entries: ArtifactManifestEntry[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (looksLikeArtifactPath(value)) {
      entries.push({ path: value, purpose: inferArtifactPurpose(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectArtifactManifestEntries(item, entries));
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && looksLikeArtifactEntry(record)) {
    entries.push({
      path: record.path,
      purpose:
        typeof record.purpose === 'string' ? record.purpose : inferArtifactPurpose(record.path),
      ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
      ...(typeof record.type === 'string' ? { type: record.type as ArtifactManifestType } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
      ...(typeof record.sha256 === 'string' ? { sha256: record.sha256 } : {}),
      ...(typeof record.timelinePath === 'string' ? { timelinePath: record.timelinePath } : {}),
      ...(typeof record.timelineUnavailableReason === 'string'
        ? { timelineUnavailableReason: record.timelineUnavailableReason }
        : {}),
    });
  }

  Object.values(record).forEach((item) => collectArtifactManifestEntries(item, entries));
}

function looksLikeArtifactEntry(record: Record<string, unknown>): boolean {
  const path = record.path;
  if (typeof path !== 'string') return false;
  return (
    typeof record.purpose === 'string' ||
    typeof record.type === 'string' ||
    typeof record.mimeType === 'string' ||
    looksLikeArtifactPath(path)
  );
}

function looksLikeArtifactPath(value: string): boolean {
  return (
    IMAGE_EXTS.test(value) ||
    isRunEvidenceVideoArtifact({ path: value }) ||
    /\.(md|json|txt|log|diff|patch)$/i.test(value)
  );
}

export function artifactPathsToManifest(paths: string[]): ArtifactManifestEntry[] {
  return paths.map((path) => ({
    path,
    purpose: inferArtifactPurpose(path),
  }));
}

export function dedupeArtifacts(entries: ArtifactManifestEntry[]): ArtifactManifestEntry[] {
  const merged = new Map<string, ArtifactManifestEntry>();
  for (const entry of entries) {
    const existing = merged.get(entry.path);
    if (!existing) {
      merged.set(entry.path, entry);
      continue;
    }
    merged.set(entry.path, mergeArtifactMetadata(existing, entry));
  }
  return [...merged.values()];
}

function mergeArtifactMetadata(
  existing: ArtifactManifestEntry,
  incoming: ArtifactManifestEntry,
): ArtifactManifestEntry {
  const merged = { ...existing };
  for (const key of [
    'sha256',
    'timelinePath',
    'timelineUnavailableReason',
    'bundleDigest',
  ] as const) {
    if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  const incomingPurposeSpecificity = artifactPurposeSpecificity(incoming.purpose);
  const existingPurposeSpecificity = artifactPurposeSpecificity(existing.purpose);
  const incomingIsMoreSpecific = incomingPurposeSpecificity > existingPurposeSpecificity;
  if (incomingIsMoreSpecific) {
    merged.purpose = incoming.purpose;
  }
  if (
    incoming.sizeBytes !== undefined &&
    (merged.sizeBytes === undefined || incomingIsMoreSpecific)
  )
    merged.sizeBytes = incoming.sizeBytes;
  if (incoming.type !== undefined && (merged.type === undefined || incomingIsMoreSpecific))
    merged.type = incoming.type;
  if (incoming.label !== undefined && (merged.label === undefined || incomingIsMoreSpecific))
    merged.label = incoming.label;
  if (incoming.nodeId !== undefined && (merged.nodeId === undefined || incomingIsMoreSpecific))
    merged.nodeId = incoming.nodeId;
  if (incoming.mimeType !== undefined && (merged.mimeType === undefined || incomingIsMoreSpecific))
    merged.mimeType = incoming.mimeType;
  if (
    incoming.recipeRunId !== undefined &&
    (merged.recipeRunId === undefined || incomingIsMoreSpecific)
  )
    merged.recipeRunId = incoming.recipeRunId;
  if (
    incoming.sourceLabel !== undefined &&
    (merged.sourceLabel === undefined || incomingIsMoreSpecific)
  )
    merged.sourceLabel = incoming.sourceLabel;
  if (
    incoming.sourceStatus !== undefined &&
    (merged.sourceStatus === undefined || incomingIsMoreSpecific)
  )
    merged.sourceStatus = incoming.sourceStatus;
  return merged;
}

function artifactPurposeSpecificity(purpose: string): number {
  if (/\b(before|after|current|candidate|baseline|reference)\b/.test(purpose)) return 3;
  if (purpose === 'other') return 0;
  if (!NEUTRAL_VISUAL_PURPOSES.has(purpose) && purpose !== 'artifact') return 2;
  if (purpose === 'artifact') return 0;
  return 1;
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
