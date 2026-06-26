import type { RecipeRunArtifactGroup, Run } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';

import {
  isSlotViewPinnedLinkedRun,
  slotViewLoadedRunDrawerKey,
  slotViewPendingReviewDecision,
  slotViewReviewDrawerKey,
} from './slot-view-model.js';
import { requestedRunFromHash } from './slot-view-url-state.js';
import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';
import {
  slotViewDesiredRecipeRunId,
  slotViewSelectedRecipeArtifactPath,
  slotViewSelectedRecipeFlowPath,
} from './slot-view-recipe-view-model.js';

export function resetSlotViewRecipePanelState(view: SlotViewRecipePresenter): void {
  view._linkedRun = null;
  // Reset the run-identity tracker too so that cross-slot navigation does not
  // carry the previous slot's run id forward. Without this, the next slot's
  // first _applyLinkedRun computes runChanged=true against the unrelated prior
  // slot's run and wipes the new slot's persisted role/context pin even though
  // that slot's run never changed.
  view._lastLinkedRunId = null;
  view._linkedRunRefreshToken = Symbol('linked-run-refresh');
  view._recipeRunsRefreshToken = Symbol('recipe-runs-refresh');
  resetSlotViewRecipeLoadTokens(view);
  view._recipeRuns = [];
  view._selectedRecipeRunId = '';
  view._selectedRecipeFlowPath = '';
  view._selectedRecipeFlowJson = '';
  view._selectedRecipeFlowLoading = false;
  view._selectedRecipeFlowError = '';
  view._selectedRecipeNodeId = '';
  view._recipeEvidenceMode = 'all';
  view._selectedRecipeArtifactPath = null;
  view._selectedRecipeArtifactText = '';
  view._selectedRecipeArtifactLoading = false;
  view._selectedRecipeArtifactError = '';
  view._recipeRunsLoading = false;
  view._recipeRunsError = '';
  view._recipeExecutionOpen = false;
  view._recipeExecutionLabel = '';
  view._recipeExecutionArtifactPath = '';
  view._recipeExecutionRecipeRunId = '';
  view._selectedRecipeEvidenceManifest = [];
  view._recipeEvidenceCache = null;
}

export async function refreshSlotViewArtifactMirror(view: SlotViewRecipePresenter): Promise<void> {
  if (!view._linkedRun?.id || view._mirrorRefreshing) return;
  view._mirrorRefreshing = true;
  view._mirrorRefreshFeedback = '';
  try {
    const result = await gateway.request<{ ok: boolean; copied?: number; reason?: string }>(
      Methods.RUN_REFRESH_MIRROR,
      { runId: view._linkedRun.id },
    );
    if (result.ok) {
      view._mirrorRefreshFeedback = result.copied ? `Synced ${result.copied}` : 'Up to date';
      view._artifactMirrorEpoch += 1;
      await view._refreshLinkedRun(view._linkedRun.status ?? null);
    } else {
      view._mirrorRefreshFeedback = result.reason ?? 'Failed';
    }
  } finally {
    view._mirrorRefreshing = false;
    setTimeout(() => {
      view._mirrorRefreshFeedback = '';
    }, 2500);
  }
}

/** Kick off recipe-runs fetch with loading state set synchronously (avoids a paint where the terminal gate hides the drawer). */
export function scheduleSlotViewRecipeRunsRefresh(
  view: SlotViewRecipePresenter,
  run: Run | null,
): void {
  if (!run) {
    clearSlotViewRecipeRuns(view);
    return;
  }
  view._recipeRunsRefreshToken = Symbol('recipe-runs-refresh');
  view._recipeRunsLoading = true;
  view._recipeRunsError = '';
  void refreshSlotViewRecipeRuns(view, run);
}

export async function refreshSlotViewRecipeRuns(
  view: SlotViewRecipePresenter,
  run: Run | null,
): Promise<void> {
  if (!run) return;

  const refreshToken = view._recipeRunsRefreshToken;
  try {
    const result = await gateway.request<{
      recipeRuns: RecipeRunArtifactGroup[];
      selectedRecipeRunId: string | null;
    }>(Methods.RUN_RECIPE_RUNS_FOR_RUN, { runId: run.id });
    if (refreshToken !== view._recipeRunsRefreshToken) return;
    applySlotViewRecipeRunsResult(view, run, result);
  } catch (error) {
    if (refreshToken !== view._recipeRunsRefreshToken) return;
    view._recipeRuns = [];
    view._selectedRecipeRunId = '';
    resetSlotViewRecipeLoadTokens(view);
    view._recipeRunsError = error instanceof Error ? error.message : String(error);
    view._recipeEvidenceCache = null;
  } finally {
    if (refreshToken === view._recipeRunsRefreshToken) view._recipeRunsLoading = false;
  }
}

function clearSlotViewRecipeRuns(view: SlotViewRecipePresenter): void {
  view._recipeRuns = [];
  view._selectedRecipeRunId = '';
  view._selectedRecipeArtifactPath = null;
  resetSlotViewRecipeLoadTokens(view);
  view._recipeRunsLoading = false;
  view._recipeRunsError = '';
  view._recipeEvidenceCache = null;
}

function resetSlotViewRecipeLoadTokens(view: SlotViewRecipePresenter): void {
  view._selectedRecipeFlowLoadToken = Symbol('recipe-flow-load');
  view._selectedRecipeEvidenceManifestLoadToken = Symbol('recipe-evidence-manifest-load');
  view._selectedRecipeArtifactPreviewLoadToken = Symbol('recipe-artifact-preview-load');
}

function applySlotViewRecipeRunsResult(
  view: SlotViewRecipePresenter,
  run: Run,
  result: { recipeRuns: RecipeRunArtifactGroup[]; selectedRecipeRunId: string | null },
): void {
  view._recipeRuns = result.recipeRuns;
  const pendingRecipeRunId = view._pendingRecipeRunSelectionId;
  const desiredId = slotViewDesiredRecipeRunId({
    recipeRuns: result.recipeRuns,
    requestedRecipeRunId: view._requestedRecipeRunFromUrl(),
    pendingRecipeRunId,
    currentRecipeRunId: view._selectedRecipeRunId,
    gatewaySelectedRecipeRunId: result.selectedRecipeRunId,
  });
  view._selectedRecipeRunId = desiredId;
  if (pendingRecipeRunId && desiredId === pendingRecipeRunId) {
    view._pendingRecipeRunSelectionId = '';
  }
  const selectedRun = result.recipeRuns.find((group) => group.id === desiredId) ?? null;
  const requestedRecipeArtifactPath = view._requestedRecipeArtifactFromUrl();
  const desiredRecipeArtifactPath = requestedRecipeArtifactPath ?? view._selectedRecipeArtifactPath;
  view._recipeEvidenceCache = null;
  const nextHost = createSlotViewRecipeHostEntry(run, view.slotId, selectedRun);
  view._selectedRecipeFlowPath = slotViewSelectedRecipeFlowPath({
    selectedRun,
    requestedFlow: view._requestedRecipeFlowFromUrl(),
  });
  view._selectedRecipeArtifactPath = slotViewSelectedRecipeArtifactPath({
    desiredRecipeArtifactPath,
    selectedRun,
    recipeHost: nextHost,
  });
  const pinnedLinkedRun = isSlotViewPinnedLinkedRun(run.id, requestedRunFromHash());
  const drawerKey =
    slotViewReviewDrawerKey({
      run,
      readyDecision: view._readyGateDecision(),
      reviewDecision: slotViewPendingReviewDecision(run),
      hasRecipeHost: !!nextHost,
    }) || (pinnedLinkedRun ? slotViewLoadedRunDrawerKey(run.id) : '');
  const shouldAutoOpen = drawerKey !== '' && drawerKey !== view._dismissedReviewDrawerKey;
  if (shouldAutoOpen && !view._reviewPanelOpen) {
    view._reviewPanelOpen = true;
  }
  void view._loadSelectedRecipeFlow(nextHost);
  void view._loadSelectedRecipeEvidenceManifest(nextHost);
  void view._loadSelectedRecipeArtifactPreview(nextHost);
}
