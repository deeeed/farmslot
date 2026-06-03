import type { ResultPackageManifest } from '@farmslot/protocol';

import type { EvalSelectedCase } from './eval-suite-helpers.js';

export type EvalLaunchCellStatus =
  | 'queued'
  | 'creating'
  | 'launching'
  | 'deduped'
  | 'running'
  | 'final'
  | 'failed'
  | 'error';

export interface EvalCandidateLaunchInput {
  id: string;
  label: string;
  enabled: boolean;
}

export interface EvalLaunchCell {
  cellId: string;
  caseSelectionId: string;
  candidateId: string;
  caseLabel: string;
  candidateLabel: string;
  status: EvalLaunchCellStatus;
  deduped: boolean;
  experimentId?: string;
  experimentManifestPath?: string;
  trialId?: string;
  runId?: string;
  packageId?: string;
  packagePath?: string;
  packageStatus?: string;
  durationMs?: number;
  costEstimate?: number;
  validationEvidenceCount: number;
  visualEvidenceCount: number;
  reviewEvidenceCount: number;
  missingData: string[];
  error?: string;
}

export interface EvalLaunchSummary {
  total: number;
  counts: Record<EvalLaunchCellStatus, number>;
  durationMs: number;
  costEstimate: number;
  validationEvidenceCount: number;
  visualEvidenceCount: number;
  reviewEvidenceCount: number;
  missingDataCount: number;
  errorCount: number;
}

export function buildLaunchCells(
  cases: readonly EvalSelectedCase[],
  candidates: readonly EvalCandidateLaunchInput[],
): EvalLaunchCell[] {
  return cases.flatMap((selectedCase) =>
    candidates
      .filter((candidate) => candidate.enabled)
      .map((candidate) => ({
        cellId: `${selectedCase.selectionId}:${candidate.id}`,
        caseSelectionId: selectedCase.selectionId,
        candidateId: candidate.id,
        caseLabel: selectedCase.label,
        candidateLabel: candidate.label || candidate.id,
        status: 'queued' as const,
        deduped: false,
        validationEvidenceCount: 0,
        visualEvidenceCount: 0,
        reviewEvidenceCount: 0,
        missingData: [],
      })),
  );
}

export function summarizeLaunchCells(cells: readonly EvalLaunchCell[]): EvalLaunchSummary {
  const counts: Record<EvalLaunchCellStatus, number> = {
    queued: 0,
    creating: 0,
    launching: 0,
    deduped: 0,
    running: 0,
    final: 0,
    failed: 0,
    error: 0,
  };
  let durationMs = 0;
  let costEstimate = 0;
  let validationEvidenceCount = 0;
  let visualEvidenceCount = 0;
  let reviewEvidenceCount = 0;
  let missingDataCount = 0;
  let errorCount = 0;
  for (const cell of cells) {
    counts[cell.status] += 1;
    durationMs += cell.durationMs ?? 0;
    costEstimate += cell.costEstimate ?? 0;
    validationEvidenceCount += cell.validationEvidenceCount;
    visualEvidenceCount += cell.visualEvidenceCount;
    reviewEvidenceCount += cell.reviewEvidenceCount;
    missingDataCount += cell.missingData.length;
    if (cell.status === 'error' || cell.error) errorCount += 1;
  }
  return {
    total: cells.length,
    counts,
    durationMs,
    costEstimate,
    validationEvidenceCount,
    visualEvidenceCount,
    reviewEvidenceCount,
    missingDataCount,
    errorCount,
  };
}

export function patchCell(
  cells: readonly EvalLaunchCell[],
  cellId: string,
  patch: Partial<EvalLaunchCell>,
): EvalLaunchCell[] {
  return cells.map((cell) => (cell.cellId === cellId ? { ...cell, ...patch } : cell));
}

export function cellPatchFromPackage(
  pkg: ResultPackageManifest,
): Pick<
  EvalLaunchCell,
  | 'packageId'
  | 'packageStatus'
  | 'durationMs'
  | 'costEstimate'
  | 'validationEvidenceCount'
  | 'visualEvidenceCount'
  | 'reviewEvidenceCount'
  | 'missingData'
> {
  return {
    packageId: pkg.packageId,
    packageStatus: pkg.status,
    durationMs: pkg.metrics?.durationMs,
    costEstimate: pkg.metrics?.costEstimate,
    validationEvidenceCount: pkg.validationEvidence.length,
    visualEvidenceCount: pkg.visualEvidence.length,
    reviewEvidenceCount: pkg.reviewEvidence.length,
    missingData: pkg.missingData,
  };
}
