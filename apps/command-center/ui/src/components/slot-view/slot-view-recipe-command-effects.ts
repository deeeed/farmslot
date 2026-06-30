import type { RecipeCommandResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import type { RecipeOutputPanel } from '../workspace/recipe-output-panel.js';
import type { RecipeRunnerControls } from '../workspace/recipe-runner-controls.js';

import { completedSlotViewRecipeRunId } from './slot-view-recipe-execution-model.js';
import {
  buildRecipeActionRequestParams,
  selectedRecipeRunRequestId,
} from './slot-view-recipe-helpers.js';
import type { SlotViewRecipePresenter } from './slot-view-recipe-presenter.js';

export async function copySlotViewRecipeCommand(
  view: SlotViewRecipePresenter,
  recipeArtifactPath = '',
  useSelectedRecipeRun = false,
): Promise<void> {
  if (!view._linkedRun) return;
  const params = buildRecipeActionRequestParams({
    runId: view._linkedRun.id,
    slotId: view.slotId,
    recipeArtifactPath: recipeArtifactPath || undefined,
    selectedRun: useSelectedRecipeRun ? view._selectedRecipeRun() : null,
  });
  try {
    const result = await gateway.request<RecipeCommandResult>(Methods.RECIPE_COMMAND, params);
    await navigator.clipboard.writeText(result.command);
    view._recipeCommandFeedback = 'copied';
    setTimeout(() => {
      if (view._recipeCommandFeedback === 'copied') view._recipeCommandFeedback = '';
    }, 1500);
  } catch (error) {
    console.error('Failed to copy recipe command', error);
  }
}

export function startSlotViewRecipeExecution(
  view: SlotViewRecipePresenter,
  label: string,
  recipeArtifactPath = '',
  useSelectedRecipeRun = false,
): void {
  view._recipeExecutionLabel = label;
  view._recipeExecutionArtifactPath = recipeArtifactPath;
  view._recipeExecutionRecipeRunId = useSelectedRecipeRun
    ? (selectedRecipeRunRequestId(view._selectedRecipeRun()) ?? '')
    : '';
  view._recipeExecutionOpen = false;
  view._reviewDrawerMode = 'recipe';
  view._dismissedReviewDrawerKey = '';
  view._reviewPanelOpen = true;
  view._saveLayout();
  view._syncUrlState();
  requestAnimationFrame(async () => {
    await view.updateComplete;
    const runner = view.renderRoot.querySelector<RecipeRunnerControls>(
      '#sv-recipe-runner-controls',
    );
    if (runner) {
      void runner.run();
      return;
    }
    view._recipeExecutionOpen = true;
    await view.updateComplete;
    void view.renderRoot.querySelector<RecipeOutputPanel>('#sv-recipe-overlay-runner')?.rerun();
  });
}

export function handleSlotViewRecipeExecutionComplete(
  view: SlotViewRecipePresenter,
  detail: { requestId?: string; exitCode?: number },
): void {
  const completedRecipeRunId = completedSlotViewRecipeRunId(detail.requestId);
  if (!completedRecipeRunId) return;
  view._pendingRecipeRunSelectionId = completedRecipeRunId;
  view._selectedRecipeRunId = completedRecipeRunId;
  view._selectedRecipeNodeId = '';
  view._recipeEvidenceMode = 'all';
  view._selectedRecipeArtifactPath = null;
  view._selectedRecipeFlowPath = '';
  view._recipeEvidenceCache = null;
  view._reviewDrawerMode = 'recipe';
  view._dismissedReviewDrawerKey = '';
  view._reviewPanelOpen = true;
  void view._refreshLinkedRun(view._linkedRun?.status ?? null);
  view._syncUrlState();
  // The runner writes artifacts just before emitting completion; refresh once
  // more after the filesystem mirror has had a moment to observe them. The
  // pending id check below makes stale delayed refreshes no-op after rapid reruns.
  setTimeout(() => {
    if (view._pendingRecipeRunSelectionId === completedRecipeRunId) {
      void view._refreshLinkedRun(view._linkedRun?.status ?? null);
    }
  }, 1500);
}
