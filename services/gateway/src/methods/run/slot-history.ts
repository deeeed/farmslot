import path from 'node:path';

import {
  type DiffStat,
  type ReadyGatePayload,
  type Run,
  type SlotRunHistoryEntry,
  type SlotRunHistoryParams,
  type SlotRunHistoryResult,
  summarizeRunEvidence,
} from '@farmslot/protocol';

import { loadFleetStatus } from '../../fleet/state.js';
import { listRunsForSlotHistory, runRecordPath } from '../../runs/store.js';

export function buildSlotRunHistoryEntry(
  run: Run,
  currentRunId?: string | null,
): SlotRunHistoryEntry {
  const taskDir = run.taskFile ? path.dirname(run.taskFile) : null;
  const evidenceSummary = summarizeRunEvidence(run);
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
    visualPairCount: evidenceSummary.visualPairCount,
    ...(run.links ? { links: run.links } : {}),
    runRecordPath: runRecordPath(run.id),
    currentForSlot: currentRunId === run.id,
  };
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
