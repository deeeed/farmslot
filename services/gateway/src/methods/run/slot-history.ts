import path from 'node:path';

import type {
  DiffStat,
  EvidenceManifestEntry,
  ReadyGatePayload,
  Run,
  SlotRunHistoryEntry,
  SlotRunHistoryParams,
  SlotRunHistoryResult,
} from '@farmslot/protocol';

import { loadFleetStatus } from '../../fleet/state.js';
import { listRunsForSlotHistory, runRecordPath } from '../../runs/store.js';

export function buildSlotRunHistoryEntry(
  run: Run,
  currentRunId?: string | null,
): SlotRunHistoryEntry {
  const taskDir = run.taskFile ? path.dirname(run.taskFile) : null;
  return {
    runId: run.id,
    familyId: run.familyId,
    status: run.status,
    flowType: run.flowType,
    ticketOrPr: run.ticketOrPr,
    summary: run.summary,
    project: run.project,
    branch: run.branch,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    durationMs: run.metrics.durationMs,
    runner: run.metrics.runner,
    model: run.metrics.model,
    actualModel: run.metrics.actualModel,
    runnerSessionId: run.metrics.runnerSessionId,
    runnerSessionPath: run.metrics.runnerSessionPath,
    taskFile: run.taskFile,
    taskDir,
    artifactDir: taskDir ? path.join(taskDir, 'artifacts') : null,
    prNumber: run.prNumber ?? null,
    diffStat: runDiffStatForSlotHistory(run),
    visualPairCount: runVisualPairCountForSlotHistory(run),
    ...(run.links ? { links: run.links } : {}),
    runRecordPath: runRecordPath(run.id),
    currentForSlot: currentRunId === run.id,
  };
}

function runVisualPairCountForSlotHistory(run: Run): number {
  return countHistoryVisualArtifactPairs(historyArtifactManifestForRun(run));
}

function historyArtifactManifestForRun(run: Run): EvidenceManifestEntry[] {
  const entries: EvidenceManifestEntry[] = [];
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
    collectHistoryArtifactManifestEntries(step.outputs, entries);
  }
  return dedupeHistoryArtifacts(entries);
}

function collectHistoryArtifactManifestEntries(
  value: unknown,
  entries: EvidenceManifestEntry[],
): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (looksLikeHistoryArtifactPath(value)) {
      entries.push({ path: value, purpose: inferHistoryArtifactPurpose(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectHistoryArtifactManifestEntries(item, entries));
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && looksLikeHistoryArtifactEntry(record)) {
    entries.push({
      path: record.path,
      purpose:
        typeof record.purpose === 'string'
          ? record.purpose
          : inferHistoryArtifactPurpose(record.path),
      ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
    });
  }
  Object.values(record).forEach((item) => collectHistoryArtifactManifestEntries(item, entries));
}

function looksLikeHistoryArtifactEntry(record: Record<string, unknown>): boolean {
  const pathValue = record.path;
  return (
    typeof pathValue === 'string' &&
    (typeof record.purpose === 'string' ||
      typeof record.type === 'string' ||
      typeof record.mimeType === 'string' ||
      looksLikeHistoryArtifactPath(pathValue))
  );
}

function countHistoryVisualArtifactPairs(entries: EvidenceManifestEntry[]): number {
  const buckets = new Map<
    string,
    { before?: EvidenceManifestEntry; after?: EvidenceManifestEntry }
  >();
  for (const entry of entries) {
    if (!isHistoryVisualArtifact(entry)) continue;
    const kind = historyVisualArtifactKind(entry);
    if (!kind) continue;
    const key = historyVisualPairKey(entry.path);
    const bucket = buckets.get(key) ?? {};
    bucket[kind] = entry;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].filter((bucket) => bucket.before && bucket.after).length;
}

function isHistoryVisualArtifact(entry: EvidenceManifestEntry): boolean {
  return /\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/i.test(entry.path);
}

function historyVisualArtifactKind(entry: EvidenceManifestEntry): 'before' | 'after' | null {
  const purpose = entry.purpose.toLowerCase();
  if (/\b(before|baseline|reference)\b/.test(purpose)) return 'before';
  if (/\b(after|current|candidate)\b/.test(purpose)) return 'after';
  if (/\b(before|baseline|reference)\b/.test(entry.path.toLowerCase())) return 'before';
  if (/\b(after|current|candidate)\b/.test(entry.path.toLowerCase())) return 'after';
  return null;
}

function historyVisualPairKey(pathValue: string): string {
  const base = path.basename(pathValue);
  const ext = (base.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
  const stem = (ext ? base.slice(0, -ext.length) : base)
    .replace(/^(before|baseline|reference|after|current|candidate)[-_.]*/i, '')
    .replace(/^evidence-/i, '')
    .replace(/[-_.]*(before|baseline|reference|after|current|candidate)$/i, '');
  return `${path.dirname(pathValue)}::${stem || base}::${ext}`;
}

function dedupeHistoryArtifacts(entries: EvidenceManifestEntry[]): EvidenceManifestEntry[] {
  return [...new Map(entries.map((entry) => [entry.path, entry] as const)).values()];
}

function looksLikeHistoryArtifactPath(value: string): boolean {
  return /\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm|md|json|txt|diff|patch)$/i.test(value);
}

function inferHistoryArtifactPurpose(pathValue: string): string {
  const normalized = pathValue.toLowerCase();
  if (normalized.includes('before') || normalized.includes('baseline')) return 'before';
  if (normalized.includes('after') || normalized.includes('current')) return 'after';
  if (normalized.includes('diff')) return 'diff';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('report')) return 'report';
  return 'artifact';
}

function runDiffStatForSlotHistory(run: Run): DiffStat & { available: boolean } {
  const readyDecisionDiff = (run.decisions ?? [])
    .map((decision) => decision.payload)
    .find((payload): payload is ReadyGatePayload =>
      Boolean(payload && payload.kind === 'ready' && payload.diffStat.files > 0),
    )?.diffStat;
  if (readyDecisionDiff) return { ...readyDecisionDiff, available: true };

  const stepDiff = (run.steps ?? [])
    .map((step) => step.outputs)
    .find(
      (
        output,
      ): output is { diffStat?: { additions?: number; deletions?: number; files?: number } } =>
        Boolean(
          output &&
          typeof output === 'object' &&
          !Array.isArray(output) &&
          'diffStat' in output &&
          (output as { diffStat?: unknown }).diffStat,
        ),
    )?.diffStat;
  if (stepDiff?.files) {
    return {
      files: stepDiff.files,
      additions: stepDiff.additions ?? 0,
      deletions: stepDiff.deletions ?? 0,
      available: true,
    };
  }

  return { files: 0, additions: 0, deletions: 0, available: false };
}

export async function runSlotHistory(params: SlotRunHistoryParams): Promise<SlotRunHistoryResult> {
  const slotId = params?.slotId?.trim();
  if (!slotId) throw new Error('slotId is required');
  const slot = (await loadFleetStatus()).slots.find((s) => s.slot === slotId);
  const { runs, totalCount } = listRunsForSlotHistory(slotId, { limit: params.limit });
  return {
    slotId,
    slotExists: Boolean(slot),
    runs: runs.map((run) => buildSlotRunHistoryEntry(run, slot?.currentRunId)),
    totalCount,
  };
}
