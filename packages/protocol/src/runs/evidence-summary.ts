import type { EvidenceManifestEntry, Run } from '../contracts/runs.js';
import { isRelativeArtifactPath } from '../recipe/common.js';
import { isInternalRunArtifactPath } from '../recipes/step-io.js';

/** A run artifact with the metadata its source recorded. */
export interface RunArtifactManifestEntry extends EvidenceManifestEntry {
  type?: string;
  label?: string;
  nodeId?: string;
  mimeType?: string;
  timelinePath?: string;
  timelineUnavailableReason?: string;
  bundleDigest?: string;
}

export interface RunEvidenceSummary {
  artifactCount: number;
  videoCount: number;
  visualPairCount: number;
}

/**
 * Every artifact a run reports: gate and review payloads, the captured run
 * output and step outputs, without gateway-internal launch diagnostics. Command
 * Center and Companion both read a run's artifacts through this.
 */
export function extractRunArtifactManifest(
  run: Pick<Run, 'decisions' | 'steps' | 'output'>,
): RunArtifactManifestEntry[] {
  const entries: RunArtifactManifestEntry[] = [];
  for (const decision of run.decisions ?? []) {
    const payload = decision.payload;
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
      entries.push(...runArtifactPathsToManifest(payload.reviewInputArtifactPaths ?? []));
    } else if (payload?.kind === 'no-change') {
      entries.push(...(payload.artifactManifest ?? []));
    }
  }
  // A gate keeps the frozen metadata of a file the run output captured again
  // later; the output only fills in what the gate did not record.
  const declared = new Map(dedupeRunArtifacts(entries).map((entry) => [entry.path, entry]));
  for (const artifact of run.output?.artifactManifest ?? []) {
    if (isInternalRunArtifactPath(artifact.path)) continue;
    const frozen = declared.get(artifact.path);
    entries.push(frozen ? { ...artifact, ...frozen } : artifact);
  }
  for (const step of run.steps ?? []) {
    collectRunArtifactEntries(step.outputs, entries);
  }
  return dedupeRunArtifacts(entries);
}

export function runEvidenceArtifacts(
  run: Pick<Run, 'decisions' | 'steps' | 'output' | 'liveRecipeContext'>,
): RunArtifactManifestEntry[] {
  return dedupeRunArtifacts([
    ...(run.liveRecipeContext?.artifactManifest ?? []),
    ...extractRunArtifactManifest(run),
  ]);
}

export function summarizeRunEvidence(
  run: Pick<Run, 'decisions' | 'steps' | 'output' | 'liveRecipeContext'>,
): RunEvidenceSummary {
  const artifacts = runEvidenceArtifacts(run);
  return {
    artifactCount: artifacts.length,
    videoCount: artifacts.filter(isRunEvidenceVideoArtifact).length,
    visualPairCount: countRunEvidenceVisualPairs(artifacts),
  };
}

export function isRunEvidenceVideoArtifact(entry: Pick<EvidenceManifestEntry, 'path'>): boolean {
  return /\.(mp4|mov|m4v|webm)$/i.test(entry.path);
}

export function isRunEvidenceImageArtifact(entry: Pick<EvidenceManifestEntry, 'path'>): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i.test(entry.path);
}

/** Canonical "is this evidence displayable" check — image or video. Single
 * source of truth for visual evidence formats across gateway and UI surfaces. */
export function isRunEvidenceVisualArtifact(entry: Pick<EvidenceManifestEntry, 'path'>): boolean {
  return isRunEvidenceImageArtifact(entry) || isRunEvidenceVideoArtifact(entry);
}

export function runArtifactPathsToManifest(paths: readonly string[]): RunArtifactManifestEntry[] {
  return paths.map((path) => ({ path, purpose: inferRunArtifactPurpose(path) }));
}

/** Image formats the clients show inline; `isRunEvidenceImageArtifact` also counts ones they can't. */
export function isRunArtifactImagePath(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(path);
}

export function inferRunArtifactPurpose(path: string): string {
  const normalized = path.toLowerCase();
  if (/\.(diff|patch)$/.test(normalized)) return 'diff';
  if (normalized.includes('screenshot')) return 'screenshot';
  if (isRunEvidenceVideoArtifact({ path })) return 'video';
  if (isRunArtifactImagePath(path)) return 'image';
  if (/diff[_-]?stat/i.test(normalized)) return 'diff-stat';
  if (/\/diff\.(txt|md)$/i.test(normalized)) return 'diff';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('report')) return 'report';
  if (normalized.includes('recipe')) return 'recipe';
  return 'artifact';
}

function collectRunArtifactEntries(value: unknown, entries: RunArtifactManifestEntry[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    // A bare string is an artifact only as a relative path, never prose or a host path.
    if (!/\s/.test(value) && isRelativeArtifactPath(value) && looksLikeRunArtifactPath(value)) {
      entries.push({ path: value, purpose: inferRunArtifactPurpose(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectRunArtifactEntries(item, entries));
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && looksLikeRunArtifactEntry(record)) {
    entries.push({
      path: record.path,
      purpose:
        typeof record.purpose === 'string' ? record.purpose : inferRunArtifactPurpose(record.path),
      ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
      ...(typeof record.type === 'string' ? { type: record.type } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
      ...(typeof record.sha256 === 'string' ? { sha256: record.sha256 } : {}),
      ...(typeof record.timelinePath === 'string' ? { timelinePath: record.timelinePath } : {}),
      ...(typeof record.timelineUnavailableReason === 'string'
        ? { timelineUnavailableReason: record.timelineUnavailableReason }
        : {}),
    });
  }

  Object.values(record).forEach((item) => collectRunArtifactEntries(item, entries));
}

function looksLikeRunArtifactEntry(record: Record<string, unknown>): boolean {
  const path = record.path;
  if (typeof path !== 'string' || !isRelativeArtifactPath(path)) return false;
  return (
    typeof record.purpose === 'string' ||
    typeof record.type === 'string' ||
    typeof record.mimeType === 'string' ||
    looksLikeRunArtifactPath(path)
  );
}

function looksLikeRunArtifactPath(value: string): boolean {
  return (
    isRunArtifactImagePath(value) ||
    isRunEvidenceVideoArtifact({ path: value }) ||
    /\.(md|json|txt|log|diff|patch)$/i.test(value)
  );
}

function countRunEvidenceVisualPairs(entries: EvidenceManifestEntry[]): number {
  const buckets = new Map<
    string,
    { before?: EvidenceManifestEntry; after?: EvidenceManifestEntry }
  >();
  for (const entry of entries) {
    if (!isRunEvidenceVisualArtifact(entry)) continue;
    const kind = runEvidenceVisualArtifactKind(entry);
    if (!kind) continue;
    const key = runEvidenceVisualPairKey(entry.path);
    const bucket = buckets.get(key) ?? {};
    bucket[kind] = entry;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].filter((bucket) => bucket.before && bucket.after).length;
}

function runEvidenceVisualArtifactKind(entry: EvidenceManifestEntry): 'before' | 'after' | null {
  const purpose = entry.purpose.toLowerCase();
  if (/\b(before|baseline|reference)\b/.test(purpose)) return 'before';
  if (/\b(after|current|candidate)\b/.test(purpose)) return 'after';
  const normalizedPath = entry.path.toLowerCase();
  if (/\b(before|baseline|reference)\b/.test(normalizedPath)) return 'before';
  if (/\b(after|current|candidate)\b/.test(normalizedPath)) return 'after';
  return null;
}

function runEvidenceVisualPairKey(pathValue: string): string {
  const base = pathBasename(pathValue);
  const ext = (base.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
  const stem = (ext ? base.slice(0, -ext.length) : base)
    .replace(/^(before|baseline|reference|after|current|candidate)[-_.]*/i, '')
    .replace(/^evidence-/i, '')
    .replace(/[-_.]*(before|baseline|reference|after|current|candidate)$/i, '');
  return `${pathDirname(pathValue)}::${stem || base}::${ext}`;
}

function pathBasename(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').split('/').pop() ?? pathValue;
}

function pathDirname(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

/** One entry per path; the most specific purpose and the latest retention metadata win. */
export function dedupeRunArtifacts<T extends RunArtifactManifestEntry>(entries: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const entry of entries) {
    const existing = merged.get(entry.path);
    merged.set(entry.path, existing ? mergeRunArtifactMetadata(existing, entry) : entry);
  }
  return [...merged.values()];
}

const LATEST_RUN_ARTIFACT_FIELDS = [
  'sha256',
  'timelinePath',
  'timelineUnavailableReason',
  'bundleDigest',
] as const;

function mergeRunArtifactMetadata<T extends RunArtifactManifestEntry>(existing: T, incoming: T): T {
  const merged = { ...existing };
  for (const key of LATEST_RUN_ARTIFACT_FIELDS) {
    if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  const incomingIsMoreSpecific =
    runArtifactPurposeSpecificity(incoming.purpose) >
    runArtifactPurposeSpecificity(existing.purpose);
  if (incomingIsMoreSpecific) merged.purpose = incoming.purpose;
  const fixed = new Set<keyof T>(['path', 'purpose', ...LATEST_RUN_ARTIFACT_FIELDS]);
  for (const key of Object.keys(incoming) as Array<keyof T>) {
    if (fixed.has(key) || incoming[key] === undefined) continue;
    if (merged[key] === undefined || incomingIsMoreSpecific) merged[key] = incoming[key];
  }
  return merged;
}

const NEUTRAL_VISUAL_PURPOSES = new Set([
  'image',
  'screenshot',
  'debug-screenshot',
  'video',
  'visual',
]);

function runArtifactPurposeSpecificity(purpose: string): number {
  if (/\b(before|after|current|candidate|baseline|reference)\b/.test(purpose)) return 3;
  if (purpose === 'other') return 0;
  if (!NEUTRAL_VISUAL_PURPOSES.has(purpose) && purpose !== 'artifact') return 2;
  if (purpose === 'artifact') return 0;
  return 1;
}
