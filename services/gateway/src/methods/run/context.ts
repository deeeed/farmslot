import {
  attachRunListSummaries,
  type LiveRecipeContext,
  type RecipeRunArtifactGroup,
  type Run,
  type RunForSlotParams,
  type RunForSlotResult,
  type RunGetParams,
  type RunGetResult,
  type RunListParams,
  type RunListResult,
  type RunRecipeRunsForRunParams,
  type RunRecipeRunsForRunResult,
  type RunRecipeRunsForSlotParams,
  type RunRecipeRunsForSlotResult,
} from '@farmslot/protocol';

import {
  selectSingleActiveRunForSlot,
  SKIP_ACTIVE_RUN_SELECTION,
} from '../../core/active-run-selection.js';
import { loadFleetStatus } from '../../fleet/state.js';
import {
  attachLiveRecipeContext,
  listRecipeRunArtifactGroupsForRun,
} from '../../live-recipe/context.js';
import { getRun, listRuns, listRunsForSlotHistory } from '../../runs/store.js';

function isReviewableTerminalRun(run: Run): boolean {
  return run.taskFile != null && (run.status === 'done' || run.status === 'failed');
}

/** Load-run binds a terminal run onto a slot via fleet currentRunId — honor that before history fallback. */
export function resolveBoundTerminalRunForSlot(
  currentRunId: string | null | undefined,
): Run | null {
  if (!currentRunId) return null;
  const run = getRun(currentRunId);
  if (!run || !isReviewableTerminalRun(run)) return null;
  return run;
}

export async function runGet(params: RunGetParams): Promise<RunGetResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  return { run: await attachLiveRecipeContext(run) };
}

export async function runList(params: RunListParams): Promise<RunListResult> {
  const result = listRuns(params);
  return attachRunListSummaries(result, params);
}

export function selectActiveRunForSlot(
  slotId: string,
  active: Run[],
  currentRunId?: string | null,
): Run | null {
  // Thin policy adapter over the shared selection helper. Exposed because the
  // run.forSlot RPC wants the warn-and-null UX (no throw) — the gateway must
  // keep responding even when a slot briefly carries two active runs.
  // onMissingPointer:'warn-null' (NOT 'fallback') is intentional: when the
  // slot's currentRunId pointer references a missing/wrong-slot run, falling
  // through to the slotId-only filter could substitute a different active run
  // that the UI then drives terminal subscriptions against — a brief "no run"
  // flash is preferable to the wrong run.
  const result = selectSingleActiveRunForSlot(slotId, active, {
    currentRunId,
    onAmbiguous: 'warn-null',
    onMissingPointer: 'warn-null',
    logPrefix: '[run]',
  });
  return result === SKIP_ACTIVE_RUN_SELECTION ? null : result;
}

export async function runForSlot(params: RunForSlotParams): Promise<RunForSlotResult> {
  const { runs: active } = listRuns({ active: true });
  const slot = (await loadFleetStatus()).slots.find((s) => s.slot === params.slotId);
  const boundTerminal = resolveBoundTerminalRunForSlot(slot?.currentRunId);
  if (boundTerminal) {
    return { run: await attachLiveRecipeContext(boundTerminal) };
  }
  const activeRun = selectActiveRunForSlot(params.slotId, active, slot?.currentRunId);
  if (activeRun) return { run: await attachLiveRecipeContext(activeRun) };
  // Fall back to the most-recent reviewable run that ran on this slot so an
  // idle slot still surfaces its just-completed task's recipe panel + evidence.
  // Filter to runs that actually completed enough to be reviewable (taskFile
  // present, status done/failed) — `cancelled` runs may have died before
  // producing artifacts; pre-WRITE_TASK failures have null taskFile and would
  // render an empty error state. Without these filters the fallback can
  // surface stale data from before a slot reassignment or a half-prepared
  // run currently mid-dispatch.
  const { runs: recent } = listRunsForSlotHistory(params.slotId, { limit: 5 });
  const reviewable = recent.find(
    (r) => r.taskFile != null && (r.status === 'done' || r.status === 'failed'),
  );
  if (!reviewable) return { run: null };
  return { run: await attachLiveRecipeContext(reviewable) };
}

export async function runRecipeRunsForSlot(
  params: RunRecipeRunsForSlotParams,
): Promise<RunRecipeRunsForSlotResult> {
  const { runs: active } = listRuns({ active: true });
  const slot = (await loadFleetStatus()).slots.find((s) => s.slot === params.slotId);
  const run =
    resolveBoundTerminalRunForSlot(slot?.currentRunId) ??
    selectActiveRunForSlot(params.slotId, active, slot?.currentRunId);
  if (!run) return { recipeRuns: [], selectedRecipeRunId: null };
  const enrichedRun = await attachLiveRecipeContext(run);
  const recipeRuns = await listRecipeRunArtifactGroupsForRun(enrichedRun);
  const selectedRecipeRunId = selectRecipeRunId(recipeRuns, enrichedRun.liveRecipeContext ?? null);
  return { recipeRuns, selectedRecipeRunId };
}

export function selectRecipeRunId(
  recipeRuns: Array<Pick<RecipeRunArtifactGroup, 'id' | 'recipeRunId' | 'artifactRoot'>>,
  liveRecipeContext: Pick<LiveRecipeContext, 'recipeRunId' | 'artifactRoot'> | null,
): string | null {
  return (
    recipeRuns.find(
      (group) => group.recipeRunId && group.recipeRunId === liveRecipeContext?.recipeRunId,
    )?.id ??
    recipeRuns.find(
      (group) => group.artifactRoot && group.artifactRoot === liveRecipeContext?.artifactRoot,
    )?.id ??
    recipeRuns[0]?.id ??
    null
  );
}

export async function runRecipeRunsForRun(
  params: RunRecipeRunsForRunParams,
): Promise<RunRecipeRunsForRunResult> {
  const run = getRun(params.runId);
  // Run-scoped mobile artifact review is anchored to an explicit run id; unlike
  // the slot-scoped helper, a missing run is caller state drift and should surface.
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const enrichedRun = await attachLiveRecipeContext(run);
  const recipeRuns = await listRecipeRunArtifactGroupsForRun(enrichedRun);
  const selectedRecipeRunId = selectRecipeRunId(recipeRuns, enrichedRun.liveRecipeContext ?? null);
  return { recipeRuns, selectedRecipeRunId };
}
