import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  Events,
  type HumanGrade,
  isTerminalRunStatus,
  type Run,
  type RunArchiveParams,
  type RunArchiveResult,
  type RunBulkDeleteParams,
  type RunBulkDeleteResult,
  type RunCleanupParams,
  type RunCleanupResult,
  type RunDeleteParams,
  type RunDeleteResult,
  type RunGetGradeParams,
  type RunGetGradeResult,
  type RunGradeParams,
  type RunGradeResult,
} from '@farmslot/protocol';

import {
  archiveRun as storeArchiveRun,
  bulkDeleteRuns as storeBulkDelete,
  cleanupRuns as storeCleanup,
  deleteRun as storeDeleteRun,
  getRun,
  listRuns,
  updateRun,
} from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

export function runGrade(params: RunGradeParams, emit: Emit): RunGradeResult {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

  if (!isTerminalRunStatus(existing.status)) {
    throw new Error(`Can only grade completed runs (status=${existing.status})`);
  }

  const run = updateRun(params.runId, { humanGrade: params.grade });

  // Also write grade.json for backward compat with FINE-TUNING.md scripts
  writeGradeArtifact(existing, params.grade);

  emit(Events.RUN_UPDATED, { run });
  return { run };
}

export function runGetGrade(params: RunGetGradeParams): RunGetGradeResult {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  return { grade: existing.humanGrade ?? null };
}

export async function runDelete(params: RunDeleteParams, emit: Emit): Promise<RunDeleteResult> {
  const ok = await storeDeleteRun(params.runId);
  if (!ok) throw new Error(`Run not found: ${params.runId}`);
  emit(Events.RUN_DELETED, { runId: params.runId });
  return { ok: true };
}

export async function runArchive(params: RunArchiveParams, emit: Emit): Promise<RunArchiveResult> {
  const ok = await storeArchiveRun(params.runId);
  if (!ok) throw new Error(`Run not found: ${params.runId}`);
  emit(Events.RUN_DELETED, { runId: params.runId });
  return { ok: true };
}

export async function runBulkDelete(
  params: RunBulkDeleteParams,
  emit: Emit,
): Promise<RunBulkDeleteResult> {
  const deleted = await storeBulkDelete(params.runIds);
  for (const id of params.runIds) {
    emit(Events.RUN_DELETED, { runId: id });
  }
  return { deleted };
}

export async function runCleanup(params: RunCleanupParams): Promise<RunCleanupResult> {
  return storeCleanup(params.dryRun ?? true);
}

export interface RunBackfillSummariesParams {
  dryRun?: boolean;
}

export interface RunBackfillSummariesResult {
  processed: number;
  skipped: number;
  failed: number;
  details: Array<{ runId: string; ticketOrPr: string; summary: string; method: string }>;
}

export async function runBackfillSummaries(
  params: RunBackfillSummariesParams,
  emit: Emit,
): Promise<RunBackfillSummariesResult> {
  const { generateSummary } = await import('../../intelligence/engine.js');
  const { runs: allRuns } = listRuns({ limit: 500 });
  const needsSummary = allRuns.filter((r) => !r.summary);

  const result: RunBackfillSummariesResult = { processed: 0, skipped: 0, failed: 0, details: [] };

  for (const run of needsSummary) {
    try {
      let summary: string | undefined;
      let method = 'none';

      if (run.flowType === 'review-pr' || run.flowType === 'pr-complete') {
        // PR flows: use PR title from ticketData
        if (run.ticketData?.title) {
          summary = run.ticketData.title;
          method = 'pr-title';
        }
      } else if (run.ticketData) {
        // Bug/dev flows with ticket data: LLM summary
        if (params.dryRun) {
          summary = run.ticketData.title;
          method = 'dry-run-title';
        } else {
          const sr = await generateSummary(run.ticketData, run.flowType);
          summary = sr.summary;
          method = 'llm';
        }
      } else {
        // No ticket data — skip, nothing useful to show
        result.skipped++;
        continue;
      }

      if (!summary) {
        result.skipped++;
        continue;
      }

      if (!params.dryRun) {
        updateRun(run.id, { summary });
        emit(Events.RUN_UPDATED, { run: getRun(run.id) });
      }
      result.processed++;
      result.details.push({
        runId: run.id.slice(0, 8),
        ticketOrPr: run.ticketOrPr,
        summary,
        method,
      });
    } catch (err) {
      console.warn(
        `[run] backfill summary failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
      );
      result.failed++;
    }
  }

  console.log(
    `[run] backfill summaries: ${result.processed} processed, ${result.skipped} skipped, ${result.failed} failed (dryRun=${params.dryRun ?? true})`,
  );
  return result;
}

async function writeGradeArtifact(run: Run, grade: HumanGrade): Promise<void> {
  if (!run.taskFile) return;
  try {
    const taskDir = path.dirname(run.taskFile);
    const artifactsDir = path.join(taskDir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, 'grade.json'), JSON.stringify(grade, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[run] grade artifact write failed: ${(err as Error).message}`);
  }
}
