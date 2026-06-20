import type { EvidenceManifestEntry, Run } from '../contracts/runs.js';

export interface RunEvidenceSummary {
  artifactCount: number;
  videoCount: number;
  visualPairCount: number;
}

export function runEvidenceArtifacts(
  run: Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'>,
): EvidenceManifestEntry[] {
  const entries: EvidenceManifestEntry[] = [];
  entries.push(...(run.liveRecipeContext?.artifactManifest ?? []));
  for (const decision of run.decisions ?? []) {
    const payload = decision.payload;
    if (!payload) continue;
    if (payload.kind === 'ready') {
      entries.push(...(payload.artifactManifest ?? []));
      entries.push(...(payload.prPackage?.evidenceManifest ?? []));
    } else if (payload.kind === 'review' || payload.kind === 'no-change') {
      entries.push(...(payload.artifactManifest ?? []));
    }
  }
  for (const step of run.steps ?? []) {
    collectRunEvidenceArtifactEntries(step.outputs, entries);
  }
  return dedupeRunEvidenceArtifacts(entries);
}

export function summarizeRunEvidence(
  run: Pick<Run, 'decisions' | 'steps' | 'liveRecipeContext'>,
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

function collectRunEvidenceArtifactEntries(value: unknown, entries: EvidenceManifestEntry[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (looksLikeRunEvidenceArtifactPath(value)) {
      entries.push({ path: value, purpose: inferRunEvidenceArtifactPurpose(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectRunEvidenceArtifactEntries(item, entries));
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && looksLikeRunEvidenceArtifactEntry(record)) {
    entries.push({
      path: record.path,
      purpose:
        typeof record.purpose === 'string'
          ? record.purpose
          : inferRunEvidenceArtifactPurpose(record.path),
      ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
    });
  }
  Object.values(record).forEach((item) => collectRunEvidenceArtifactEntries(item, entries));
}

function looksLikeRunEvidenceArtifactEntry(record: Record<string, unknown>): boolean {
  const pathValue = record.path;
  return (
    typeof pathValue === 'string' &&
    (typeof record.purpose === 'string' ||
      typeof record.type === 'string' ||
      typeof record.mimeType === 'string' ||
      looksLikeRunEvidenceArtifactPath(pathValue))
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

function isRunEvidenceVisualArtifact(entry: EvidenceManifestEntry): boolean {
  return /\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/i.test(entry.path);
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

function dedupeRunEvidenceArtifacts(entries: EvidenceManifestEntry[]): EvidenceManifestEntry[] {
  return [...new Map(entries.map((entry) => [entry.path, entry] as const)).values()];
}

function looksLikeRunEvidenceArtifactPath(value: string): boolean {
  return /\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm|md|json|txt|diff|patch)$/i.test(value);
}

function inferRunEvidenceArtifactPurpose(pathValue: string): string {
  const normalized = pathValue.toLowerCase();
  if (normalized.includes('before') || normalized.includes('baseline')) return 'before';
  if (normalized.includes('after') || normalized.includes('current')) return 'after';
  if (normalized.includes('diff')) return 'diff';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('report')) return 'report';
  return 'artifact';
}
