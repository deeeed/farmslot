import type { RecipeRunArtifactGroup, Run } from '@farmslot/protocol';

import { createSlotViewRecipeHostEntry } from '../recipe/recipe-quality-hosts.js';
import { refreshRunMirror } from '../shared/run-mirror-refresh.js';

import {
  isSlotViewPinnedLinkedRun,
  slotViewLoadedRunDrawerKey,
  slotViewPendingReviewDecision,
  slotViewReviewDrawerKey,
} from './slot-view-model.js';
import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';
import {
  slotViewDesiredRecipeRunId,
  slotViewSelectedRecipeArtifactPath,
  slotViewSelectedRecipeDependencyPath,
} from './slot-view-recipe-view-model.js';
import { requestedRunFromHash } from './slot-view-url-state.js';

export function resetSlotViewRecipePanelState(view: SlotViewRecipePresenter): void {
  view._linkedRun = null;
  // Reset the run-identity tracker too so that cross-slot navigation does not
  // carry the previous slot's run id forward. Without this, the next slot's
  // first _applyLinkedRun computes runChanged=true against the unrelated prior
  // slot's run and wipes the new slot's persisted role/context pin even though
  // that slot's run never changed.
  view._lastLinkedRunId = null;
  view._lastLinkedRunActiveTaskFile = null;
  view._lastLinkedRunReviewProgress = null;
  resetSlotViewRecipeLoadTokens(view);
  view._recipeRuns = [];
  view._selectedRecipeRunId = '';
  view._selectedRecipeDependencyPath = '';
  view._selectedRecipeDependencyJson = '';
  view._selectedRecipeDependencyLoading = false;
  view._selectedRecipeDependencyError = '';
  view._selectedRecipeNodeId = '';
  view._recipeEvidenceMode = 'all';
  view._selectedRecipeArtifactPath = null;
  view._selectedRecipeArtifactText = '';
  view._selectedRecipeArtifactLoading = false;
  view._selectedRecipeArtifactError = '';
  view._recipeRunsLoading = false;
  view._recipeRunsError = '';
  retireSlotViewRunCommands(view);
  view._selectedRecipeEvidenceManifest = [];
  view._recipeEvidenceCache = null;
}

export function retireSlotViewRunCommands(view: SlotViewRecipePresenter): void {
  view._recipeExecutionOpen = false;
  view._recipeExecutionLabel = '';
  view._recipeExecutionArtifactPath = '';
  view._recipeExecutionRecipeRunId = '';
  view._pendingRecipeRunSelectionId = '';
  view._recipeCommandFeedback = '';
  view._mirrorRequest = undefined;
  view._mirrorRefreshing = false;
  view._mirrorRefreshFeedback = '';
  view._tmuxRestoreRequest = undefined;
  view._tmuxRestoreRunning = false;
  view._tmuxRestoreFeedback = '';
  view._tmuxRestoreError = '';
  view._runCommandError = '';
}

export async function refreshSlotViewArtifactMirror(view: SlotViewRecipePresenter): Promise<void> {
  if (
    !view._linkedRun?.id ||
    view._mirrorRequest ||
    view._runActionsBlocked ||
    !view._recipeRunsCurrent
  )
    return;
  const request = Symbol('mirror-sync');
  view._mirrorRequest = request;
  view._mirrorRefreshing = true;
  view._mirrorRefreshFeedback = '';
  let current = () => view.isConnected;
  try {
    const run = view._requireCurrentRecipes();
    current = view._captureRunScope();
    const result = await refreshRunMirror(run.id);
    if (!current()) return;
    view._mirrorRefreshFeedback = result.ok
      ? result.copied
        ? `Synced ${result.copied}`
        : 'Up to date'
      : result.reason || 'Artifact sync failed';
    if (result.ok) view._artifactMirrorEpoch += 1;
  } catch (error) {
    if (current())
      view._mirrorRefreshFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    if (view._mirrorRequest === request) {
      view._mirrorRequest = undefined;
      view._mirrorRefreshing = false;
    }
  }
}

export function clearSlotViewRecipeRuns(view: SlotViewRecipePresenter): void {
  view._recipeRuns = [];
  view._selectedRecipeRunId = '';
  view._selectedRecipeArtifactPath = null;
  resetSlotViewRecipeLoadTokens(view);
  view._recipeEvidenceCache = null;
}

function resetSlotViewRecipeLoadTokens(view: SlotViewRecipePresenter): void {
  view._selectedRecipeDependencyLoadToken = Symbol('recipe-library-load');
  view._selectedRecipeEvidenceManifestLoadToken = Symbol('recipe-evidence-manifest-load');
  view._selectedRecipeArtifactPreviewLoadToken = Symbol('recipe-artifact-preview-load');
}

export function applySlotViewRecipeRunsResult(
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
  view._selectedRecipeDependencyPath = slotViewSelectedRecipeDependencyPath({
    selectedRun,
    requestedDependency: view._requestedRecipeDependencyFromUrl(),
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
  void view._loadSelectedRecipeDependency(nextHost);
  void view._loadSelectedRecipeEvidenceManifest(nextHost);
  void view._loadSelectedRecipeArtifactPreview(nextHost);
}
