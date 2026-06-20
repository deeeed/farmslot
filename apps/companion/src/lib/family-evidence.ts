import {
  type FamilyObservabilityArtifact,
  type FamilyObservabilityRunSummary,
  isRunEvidenceVideoArtifact,
} from '@farmslot/protocol';

import { isAfterVisualArtifact, isBeforeVisualArtifact } from './artifact-url';

export type FamilyEvidenceFilter =
  | 'all'
  | 'before'
  | 'after'
  | 'review'
  | 'diffs'
  | 'recipes'
  | 'setup'
  | 'videos';
export type FamilyEvidenceKind = Exclude<FamilyEvidenceFilter, 'all' | 'videos'>;

export const MAX_FAMILY_EVIDENCE_GROUPS = 8;
export const MAX_ARTIFACTS_PER_FAMILY_EVIDENCE_GROUP = 6;

export interface FamilyEvidenceGroup {
  key: string;
  title: string;
  subtitle: string;
  artifacts: FamilyObservabilityArtifact[];
  run: FamilyRunEvidenceSummary | null;
  capturedBeforeRun: boolean;
  capturedAtMs: number | null;
}

export type FamilyRunEvidenceSummary = Pick<
  FamilyObservabilityRunSummary,
  'runId' | 'flowType' | 'lane' | 'ticketOrPr' | 'slotId' | 'createdAt' | 'diffStat'
>;

interface CaptureBatch {
  key: string;
  label: string;
  dateKey: string;
  capturedAtMs: number | null;
}

interface FamilyEvidenceSnapshot {
  evidence: FamilyObservabilityArtifact[];
}

export function familyArtifactKind(artifact: FamilyObservabilityArtifact): FamilyEvidenceKind {
  const filename = (artifact.path.split('/').pop() ?? '').toLowerCase();
  const purpose = artifact.purpose ?? '';
  if (/^before([-._]|$)/.test(filename)) return 'before';
  if (/^after([-._]|$)/.test(filename)) return 'after';
  if (/[-._]before$/.test(filename.replace(/\.[^.]+$/, ''))) return 'before';
  if (/[-._]after$/.test(filename.replace(/\.[^.]+$/, ''))) return 'after';
  if (purpose === 'debug-screenshot') return 'setup';
  if (filename.startsWith('evidence-')) return 'after';
  if (isBeforeVisualArtifact(artifact)) return 'before';
  if (isAfterVisualArtifact(artifact)) return 'after';
  const upperPurpose = purpose.toUpperCase();
  if (upperPurpose.includes('BEFORE')) return 'before';
  if (upperPurpose.includes('AFTER')) return 'after';
  const normalized = `${artifact.path} ${purpose} ${artifact.source ?? ''}`.toLowerCase();
  if (isRecipeEvidence(normalized, artifact)) return 'recipes';
  if (isDiffEvidence(normalized)) return 'diffs';
  if (isReviewEvidence(normalized)) return 'review';
  return 'setup';
}

export function isFamilyVideoArtifact(
  artifact: Pick<FamilyObservabilityArtifact, 'path'>,
): boolean {
  return isRunEvidenceVideoArtifact(artifact);
}

export function familyEvidenceKindLabel(kind: FamilyEvidenceKind): string {
  if (kind === 'before') return 'Before';
  if (kind === 'after') return 'After';
  if (kind === 'review') return 'Review';
  if (kind === 'diffs') return 'Diff';
  if (kind === 'recipes') return 'Recipe';
  return 'Setup';
}

export function familyRunBadgeLabel(run: FamilyRunEvidenceSummary): string {
  if (run.lane === 'comparison' && /^EVAL-/i.test(run.ticketOrPr)) return 'EVAL';
  if (run.lane === 'comparison') return 'COMPARE';
  if (run.flowType === 'fix-bug') return 'FIX';
  if (run.flowType === 'review-pr') return 'REVIEW';
  if (run.flowType === 'pr-complete') return 'PR COMPLETE';
  if (run.flowType === 'merge-main') return 'MERGE';
  return run.flowType.toUpperCase();
}

export function buildFamilyEvidenceGroups(
  snapshot: FamilyEvidenceSnapshot | null,
  runForArtifact: (artifact: FamilyObservabilityArtifact) => FamilyRunEvidenceSummary | null,
): FamilyEvidenceGroup[] {
  if (!snapshot) return [];
  const groups = new Map<string, FamilyEvidenceGroup>();
  for (const artifact of snapshot.evidence) {
    const run = runForArtifact(artifact);
    const batch = captureBatchFromPath(artifact.path);
    const isCapturedBeforeRun = capturedBeforeRun(batch, run);
    const runKey = artifact.sourceRunId ?? artifact.runId;
    const batchKey = batch?.key ?? 'undated';
    const key = `${runKey}:${isCapturedBeforeRun ? 'earlier' : 'current'}:${batchKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.artifacts.push(artifact);
      continue;
    }
    groups.set(key, {
      key,
      title: evidenceGroupTitle(run, isCapturedBeforeRun),
      subtitle: evidenceGroupSubtitle({ artifact, batch, run, isCapturedBeforeRun }),
      artifacts: [artifact],
      run,
      capturedBeforeRun: isCapturedBeforeRun,
      capturedAtMs: batch?.capturedAtMs ?? null,
    });
  }
  return [...groups.values()]
    .sort((a, b) => (b.capturedAtMs ?? 0) - (a.capturedAtMs ?? 0))
    .slice(0, MAX_FAMILY_EVIDENCE_GROUPS);
}

export function filterFamilyEvidenceGroups(
  groups: FamilyEvidenceGroup[],
  filter: FamilyEvidenceFilter,
): FamilyEvidenceGroup[] {
  if (filter === 'all') return groups;
  return groups
    .map((group) => ({
      ...group,
      artifacts: group.artifacts.filter((artifact) =>
        filter === 'videos'
          ? isFamilyVideoArtifact(artifact)
          : familyArtifactKind(artifact) === filter,
      ),
    }))
    .filter((group) => group.artifacts.length > 0);
}

export function visibleFamilyEvidenceArtifacts(
  groups: FamilyEvidenceGroup[],
): FamilyObservabilityArtifact[] {
  return groups.flatMap((group) =>
    group.artifacts.slice(0, MAX_ARTIFACTS_PER_FAMILY_EVIDENCE_GROUP),
  );
}

function captureBatchFromPath(pathValue: string): CaptureBatch | null {
  const file = pathValue.split('/').pop() ?? pathValue;
  const match = file.match(/(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, dateKey, hour, minute, second] = match;
  const capturedAtMs = new Date(`${dateKey}T${hour}:${minute}:${second}Z`).getTime();
  return {
    key: `${dateKey}_${hour}${minute}`,
    label: `${dateKey} ${hour}:${minute}`,
    dateKey,
    capturedAtMs: Number.isFinite(capturedAtMs) ? capturedAtMs : null,
  };
}

function createdDateKey(
  run: Pick<FamilyObservabilityRunSummary, 'createdAt'> | null,
): string | null {
  return run?.createdAt?.slice(0, 10) ?? null;
}

function capturedBeforeRun(
  batch: CaptureBatch | null,
  run: Pick<FamilyObservabilityRunSummary, 'createdAt'> | null,
): boolean {
  if (!batch || !run?.createdAt) return false;
  const runCreatedAtMs = new Date(run.createdAt).getTime();
  if (
    batch.capturedAtMs !== null &&
    Number.isFinite(batch.capturedAtMs) &&
    Number.isFinite(runCreatedAtMs)
  ) {
    return batch.capturedAtMs < runCreatedAtMs - 60_000;
  }
  const runDate = createdDateKey(run);
  return Boolean(batch.dateKey && runDate && batch.dateKey < runDate);
}

function evidenceGroupTitle(
  run: FamilyRunEvidenceSummary | null,
  isCapturedBeforeRun: boolean,
): string {
  if (isCapturedBeforeRun) return 'Earlier carried-over evidence';
  if (!run) return 'Evidence';
  if (run.lane === 'comparison' && /^EVAL-/i.test(run.ticketOrPr)) return 'Eval candidate evidence';
  if (run.lane === 'comparison') return 'Comparison evidence';
  if (run.flowType === 'review-pr') return 'Review-triggered evidence';
  if (run.flowType === 'fix-bug') return 'Original bugfix evidence';
  return `${familyRunBadgeLabel(run)} evidence`;
}

function evidenceGroupSubtitle({
  artifact,
  batch,
  run,
  isCapturedBeforeRun,
}: {
  artifact: FamilyObservabilityArtifact;
  batch: CaptureBatch | null;
  run: FamilyRunEvidenceSummary | null;
  isCapturedBeforeRun: boolean;
}): string {
  const parts = [
    batch ? `Captured ${batch.label}` : 'No capture timestamp',
    run
      ? `${familyRunBadgeLabel(run)} run ${run.runId.slice(0, 8)}`
      : `Run ${artifact.runId.slice(0, 8)}`,
    run?.slotId ? `slot ${run.slotId}` : 'slot unknown',
  ];
  if (isCapturedBeforeRun) parts.push('captured before this run');
  if (artifact.sourceRunId && artifact.sourceRunId !== artifact.runId) {
    parts.push(`source ${artifact.sourceRunId.slice(0, 8)}`);
  }
  return parts.join(' · ');
}

function isRecipeEvidence(normalized: string, artifact: FamilyObservabilityArtifact): boolean {
  return normalized.includes('recipe') || 'recipeRunId' in artifact;
}

function isDiffEvidence(normalized: string): boolean {
  return (
    normalized.includes('diff') ||
    normalized.includes('patch') ||
    /\.(diff|patch)(\s|$)/.test(normalized) ||
    normalized.includes('/diff.txt')
  );
}

function isReviewEvidence(normalized: string): boolean {
  return (
    normalized.includes('review') ||
    normalized.includes('report') ||
    normalized.includes('quality') ||
    normalized.includes('verdict')
  );
}
