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
  if (!view._linkedRun || view._runActionsBlocked || !view._recipeRunsCurrent) return;
  let current = () => view.isConnected;
  try {
    const run = view._requireCurrentRecipes();
    current = view._captureRunScope();
    const params = buildRecipeActionRequestParams({
      runId: run.id,
      slotId: view.slotId,
      recipeArtifactPath: recipeArtifactPath || undefined,
      selectedRun: useSelectedRecipeRun ? view._selectedRecipeRun() : null,
    });
    const result = await gateway.request<RecipeCommandResult>(Methods.RECIPE_COMMAND, params);
    if (!current()) return;
    await navigator.clipboard.writeText(result.command);
    if (!current()) return;
    view._recipeCommandFeedback = 'copied';
    setTimeout(() => {
      if (current() && view._recipeCommandFeedback === 'copied') view._recipeCommandFeedback = '';
    }, 1500);
  } catch (error) {
    if (current()) view._runCommandError = error instanceof Error ? error.message : String(error);
  }
}

export function startSlotViewRecipeExecution(
  view: SlotViewRecipePresenter,
  label: string,
  recipeArtifactPath = '',
  useSelectedRecipeRun = false,
): void {
  if (view._runActionsBlocked || !view._recipeRunsCurrent) return;
  let current: () => boolean;
  try {
    view._requireCurrentRecipes();
    current = view._captureRunScope();
  } catch (error) {
    view._runCommandError = error instanceof Error ? error.message : String(error);
    return;
  }
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
    if (!current()) return;
    const runner = view.renderRoot.querySelector<RecipeRunnerControls>(
      '#sv-recipe-runner-controls',
    );
    if (runner) {
      void runner.run();
      return;
    }
    view._recipeExecutionOpen = true;
    await view.updateComplete;
    if (!current()) return;
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
  view._selectedRecipeDependencyPath = '';
  view._recipeEvidenceCache = null;
  view._reviewDrawerMode = 'recipe';
  view._dismissedReviewDrawerKey = '';
  view._reviewPanelOpen = true;
  view._syncUrlState();
}
