import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
  FlowType,
  RunLane,
} from '@farmslot/protocol';

import { buildBeforeAfterPairs } from '../../utils/artifact-pairs.js';
import type { LightboxItem, LightboxPair } from '../shared/media-lightbox-types.js';

import { formatCreatedAt } from './run-utils.js';
import { flowLabel } from './run-utils.js';

export const MAX_EVIDENCE_GROUPS = 8;
export const MAX_ARTIFACTS_PER_EVIDENCE_GROUP = 6;

const VIDEO_EXTS = /\.(mp4|mov|webm)$/i;

interface CaptureBatch {
  key: string;
  label: string;
  dateKey: string;
  capturedAtMs: number | null;
}

export interface EvidenceGroup {
  key: string;
  title: string;
  subtitle: string;
  artifacts: FamilyObservabilityArtifact[];
  run: FamilyRunEvidenceSummary | null;
  capturedBeforeRun: boolean;
  capturedAtMs: number | null;
}

type FamilyRunEvidenceSummary = Pick<
  FamilyObservabilityRunSummary,
  'runId' | 'flowType' | 'lane' | 'ticketOrPr' | 'slotId' | 'createdAt'
>;

interface FamilyEvidenceSnapshot {
  evidence: FamilyObservabilityArtifact[];
}

interface RunBadgeSummary {
  flowType: FlowType;
  lane: RunLane;
  ticketOrPr: string;
}

export function isEvalCandidateSummary(run: Pick<RunBadgeSummary, 'lane' | 'ticketOrPr'>): boolean {
  return run.lane === 'comparison' && /^EVAL-/i.test(run.ticketOrPr);
}

export function familyRunBadgeLabel(run: RunBadgeSummary): string {
  if (isEvalCandidateSummary(run)) return 'EVAL';
  return run.lane === 'comparison' ? 'COMPARE' : flowLabel(run.flowType);
}

function captureBatchFromPath(pathValue: string): CaptureBatch | null {
  const file = pathValue.split('/').pop() ?? pathValue;
  const match = file.match(/(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, dateKey, hour, minute] = match;
  return {
    key: `${dateKey}_${hour}${minute}`,
    label: `${dateKey} ${hour}:${minute}`,
    dateKey,
    capturedAtMs: new Date(`${dateKey}T${hour}:${minute}:${match[4]}Z`).getTime(),
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
  const capturedAtMs = batch.capturedAtMs;
  const runCreatedAtMs = new Date(run.createdAt).getTime();
  if (capturedAtMs !== null && Number.isFinite(capturedAtMs) && Number.isFinite(runCreatedAtMs)) {
    return capturedAtMs < runCreatedAtMs - 60_000;
  }
  const runDate = createdDateKey(run);
  return Boolean(batch.dateKey && runDate && batch.dateKey < runDate);
}

function evidenceGroupTitle(
  run: FamilyRunEvidenceSummary | null,
  capturedBeforeRunValue: boolean,
): string {
  if (capturedBeforeRunValue) return 'Earlier carried-over evidence';
  if (!run) return 'Evidence';
  if (isEvalCandidateSummary(run)) return 'Eval Candidate evidence';
  if (run.lane === 'comparison') return 'Comparison evidence';
  if (run.flowType === 'review-pr') return 'Review-triggered evidence';
  if (run.flowType === 'fix-bug') return 'Original bugfix evidence';
  return `${flowLabel(run.flowType)} evidence`;
}

export function buildFamilyLightboxPairs(
  evidence: FamilyObservabilityArtifact[],
  toLightboxItem: (artifact: FamilyObservabilityArtifact) => LightboxItem,
): LightboxPair[] {
  return buildBeforeAfterPairs(evidence).map((pair) => {
    const kind: 'image' | 'video' =
      VIDEO_EXTS.test(pair.before.path) || VIDEO_EXTS.test(pair.after.path) ? 'video' : 'image';
    return {
      before: toLightboxItem(pair.before),
      after: toLightboxItem(pair.after),
      stem: pair.stem,
      kind,
    };
  });
}

export function buildFamilyEvidenceGroups(
  snapshot: FamilyEvidenceSnapshot | null,
  runForArtifact: (artifact: FamilyObservabilityArtifact) => FamilyRunEvidenceSummary | null,
): EvidenceGroup[] {
  if (!snapshot) return [];
  const groups = new Map<string, EvidenceGroup>();
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
    const subtitleParts = [
      batch ? `Captured ${batch.label}` : 'No capture timestamp in filename',
      run
        ? `${familyRunBadgeLabel(run)} run ${run.runId.slice(0, 8)}`
        : `Run ${artifact.runId.slice(0, 8)}`,
      run?.slotId ? `slot ${run.slotId}` : 'slot unknown',
    ];
    if (run?.createdAt) subtitleParts.push(`dispatched ${formatCreatedAt(run.createdAt)}`);
    if (isCapturedBeforeRun) subtitleParts.push('captured before this run');
    if (artifact.sourceRunId && artifact.sourceRunId !== artifact.runId) {
      subtitleParts.push(`source run ${artifact.sourceRunId.slice(0, 8)}`);
    }
    groups.set(key, {
      key,
      title: evidenceGroupTitle(run, isCapturedBeforeRun),
      subtitle: subtitleParts.join(' · '),
      artifacts: [artifact],
      run,
      capturedBeforeRun: isCapturedBeforeRun,
      capturedAtMs: batch?.capturedAtMs ?? null,
    });
  }
  return [...groups.values()]
    .sort((a, b) => (b.capturedAtMs ?? 0) - (a.capturedAtMs ?? 0))
    .slice(0, MAX_EVIDENCE_GROUPS);
}

export function visibleFamilyEvidenceArtifacts(
  groups: EvidenceGroup[],
): FamilyObservabilityArtifact[] {
  return groups.flatMap((group) => group.artifacts.slice(0, MAX_ARTIFACTS_PER_EVIDENCE_GROUP));
}
