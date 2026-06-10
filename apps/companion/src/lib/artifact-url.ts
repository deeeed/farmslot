import type { RecipeRunArtifactGroup, Run } from '@farmslot/protocol';

import {
  type GatewayHttpAuthHeaders,
  gatewayResourceSource,
} from './gateway-http-auth';

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

export interface ArtifactManifestEntry {
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
): string {
  const base = wsToHttpBase(gatewayWsUrl);
  const params = new URLSearchParams({ runId, path });
  if (recipeRunId) params.set('recipeRunId', recipeRunId);
  if (mirrorEpoch && mirrorEpoch > 0) params.set('m', String(mirrorEpoch));
  return `${base}/api/run-artifact?${params.toString()}`;
}

export function artifactUrlForEntry(
  gatewayWsUrl: string,
  runId: string,
  artifact: ArtifactManifestEntry,
  mirrorEpoch?: number,
): string {
  return artifactUrl(gatewayWsUrl, runId, artifact.path, artifact.recipeRunId, mirrorEpoch);
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
const VIDEO_EXTS = /\.(mp4|webm|mov)$/i;
const DOC_EXTS = /\.(md|txt|json)$/i;
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
  if (VIDEO_EXTS.test(path)) return 'video';
  return 'other';
}

export function inferArtifactPurpose(path: string): string {
  const normalized = path.toLowerCase();
  if (/\.(diff|patch)$/.test(normalized)) return 'diff';
  if (normalized.includes('screenshot')) return 'screenshot';
  if (VIDEO_EXTS.test(path)) return 'video';
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
  return /\.(png|jpe?g|webp|gif|svg|mp4|mov|webm|md|json|txt|diff|patch)$/i.test(value);
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

export function isBeforeVisualArtifact(artifact: { path: string; purpose?: string }): boolean {
  const purpose = artifact.purpose?.toLowerCase() ?? '';
  if (/\b(before|baseline|reference)\b/.test(purpose)) return true;
  if (purpose && !NEUTRAL_VISUAL_PURPOSES.has(purpose)) return false;
  return /(^|[-_/])(before|baseline|reference)([-_./]|$)/.test(artifact.path.toLowerCase());
}

export function isAfterVisualArtifact(artifact: { path: string; purpose?: string }): boolean {
  const purpose = artifact.purpose?.toLowerCase() ?? '';
  if (/\b(after|current|candidate)\b/.test(purpose)) return true;
  if (purpose && !NEUTRAL_VISUAL_PURPOSES.has(purpose)) return false;
  return /(^|[-_/])(after|current|candidate)([-_./]|$)/.test(artifact.path.toLowerCase());
}

export function isVisualMediaArtifact(artifact: ArtifactManifestEntry): boolean {
  const mediaType = classifyArtifact(artifact);
  return mediaType === 'image' || mediaType === 'video';
}

export function groupVisualArtifactPairs<T extends ArtifactManifestEntry>(
  manifest: T[],
  urlFor: (artifact: T) => string,
): { pairs: VisualArtifactPair<T>[]; singles: T[] } {
  const pairItems = visualArtifactPairs(manifest);
  const paired = new Set<T>();
  const pairs = pairItems.map(({ before, after, stem }) => {
    paired.add(before);
    paired.add(after);
    return {
      before: { ...before, url: urlFor(before) },
      after: { ...after, url: urlFor(after) },
      stem,
    };
  });

  return { pairs, singles: manifest.filter((artifact) => !paired.has(artifact)) };
}

export function countVisualArtifactPairs<T extends ArtifactManifestEntry>(manifest: T[]): number {
  return visualArtifactPairs(manifest).length;
}

function visualArtifactPairs<T extends ArtifactManifestEntry>(
  manifest: T[],
): Array<{ before: T; after: T; stem: string }> {
  const exactBuckets = new Map<string, { before?: T; after?: T; stem: string }>();
  for (const artifact of manifest) {
    if (!isVisualMediaArtifact(artifact)) continue;
    const kind = visualArtifactKind(artifact);
    if (!kind) continue;
    const { base, ext, stem, stemForKey } = filenameStem(artifact.path);
    const key = `${artifactRunKey(artifact)}::${artifactStepKey(artifact)}::${stemForKey}::${ext}`;
    const bucket = exactBuckets.get(key) ?? { stem: stem || base };
    bucket[kind] = artifact;
    exactBuckets.set(key, bucket);
  }

  const pairs: Array<{ before: T; after: T; stem: string }> = [];
  const paired = new Set<T>();
  for (const bucket of exactBuckets.values()) {
    if (!bucket.before || !bucket.after) continue;
    pairs.push({ before: bucket.before, after: bucket.after, stem: bucket.stem });
    paired.add(bucket.before);
    paired.add(bucket.after);
  }

  const acBuckets = new Map<
    string,
    { before?: T; after?: T; stem: string; beforeCount: number; afterCount: number }
  >();
  for (const artifact of manifest) {
    if (paired.has(artifact) || !isVisualMediaArtifact(artifact)) continue;
    const kind = visualArtifactKind(artifact);
    if (!kind) continue;
    const acKey = acceptanceCriteriaKey(artifact.path);
    if (!acKey) continue;
    const { ext } = filenameStem(artifact.path);
    const key = `${artifactRunKey(artifact)}::${acKey}::${ext}`;
    const bucket = acBuckets.get(key) ?? { stem: acKey, beforeCount: 0, afterCount: 0 };
    bucket[kind] = artifact;
    if (kind === 'before') bucket.beforeCount += 1;
    else bucket.afterCount += 1;
    acBuckets.set(key, bucket);
  }
  for (const bucket of acBuckets.values()) {
    if (!bucket.before || !bucket.after || bucket.beforeCount !== 1 || bucket.afterCount !== 1) {
      continue;
    }
    pairs.push({ before: bucket.before, after: bucket.after, stem: bucket.stem });
  }

  return pairs;
}

export function deriveBaselineVisualArtifactPairs<T extends ArtifactManifestEntry>(
  manifest: T[],
  urlFor: (artifact: T) => string,
  existingPairs: Array<Pick<VisualArtifactPair<T>, 'before' | 'after'>> = [],
): VisualArtifactPair<T>[] {
  const alreadyPaired = new Set(
    existingPairs.flatMap((pair) => [pair.before.path, pair.after.path]),
  );
  const before: T[] = [];
  const after: T[] = [];
  for (const artifact of manifest) {
    if (alreadyPaired.has(artifact.path) || !isVisualMediaArtifact(artifact)) continue;
    const kind = visualArtifactKind(artifact);
    if (kind === 'before') before.push(artifact);
    if (kind === 'after') after.push(artifact);
  }

  if (before.length === 1 && after.length > 0) {
    const baseline = before[0];
    return after.map((candidate) => buildVisualArtifactPair(baseline, candidate, urlFor));
  }
  if (after.length === 1 && before.length > 0) {
    const candidate = after[0];
    return before.map((baseline) => buildVisualArtifactPair(baseline, candidate, urlFor));
  }
  return [];
}

function buildVisualArtifactPair<T extends ArtifactManifestEntry>(
  before: T,
  after: T,
  urlFor: (artifact: T) => string,
): VisualArtifactPair<T> {
  return {
    before: { ...before, url: urlFor(before) },
    after: { ...after, url: urlFor(after) },
    stem: visualArtifactPairStem({ before, after }),
  };
}

export function visualArtifactPairStem(pair: {
  before: ArtifactManifestEntry;
  after: ArtifactManifestEntry;
}): string {
  const beforeBase = pair.before.path.split('/').pop() ?? pair.before.path;
  const afterBase = pair.after.path.split('/').pop() ?? pair.after.path;
  const beforeStem = filenameStem(pair.before.path).stem;
  const afterStem = filenameStem(pair.after.path).stem;
  if (beforeStem && beforeStem === afterStem) return beforeStem;
  const acKey = acceptanceCriteriaKey(pair.before.path) ?? acceptanceCriteriaKey(pair.after.path);
  if (acKey) return acKey;
  return `${beforeBase} → ${afterBase}`;
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

function visualArtifactKind(artifact: ArtifactManifestEntry): 'before' | 'after' | null {
  if (isBeforeVisualArtifact(artifact)) return 'before';
  if (isAfterVisualArtifact(artifact)) return 'after';
  return null;
}

function filenameStem(path: string): {
  base: string;
  ext: string;
  stem: string;
  stemForKey: string;
} {
  const base = path.split('/').pop() ?? path;
  const ext = (base.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
  const noExt = ext ? base.slice(0, -ext.length) : base;
  const stem = noExt
    .replace(/^(before|baseline|reference|after|current|candidate)[-_.]*/i, '')
    .replace(/^evidence-/i, '')
    .replace(/[-_.]*(before|baseline|reference|after|current|candidate)$/i, '');
  // Empty stems must not coalesce bare sentinels like before.png/after.png.
  const stemForKey = stem || noExt || base;
  return { base, ext, stem, stemForKey };
}

function acceptanceCriteriaKey(path: string): string | null {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  const match = base.match(/(?:^|[-_.])(ac\d+)(?:[-_.]|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function artifactRunKey(artifact: ArtifactManifestEntry): string {
  return (artifact as ArtifactManifestEntry & { runId?: string | null }).runId ?? '';
}

function artifactStepKey(artifact: ArtifactManifestEntry): string {
  return (artifact as ArtifactManifestEntry & { stepName?: string | null }).stepName ?? '';
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes == null || bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
