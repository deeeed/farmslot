import { requestProjectConfigs } from '../dispatch/dispatch-wizard-loaders.js';
import {
  loadRecipeRunnerUiOptionsForProject,
  type RecipeRunnerUiOptions,
  recipeRunnerUiOptions,
} from '../workspace/recipe-runner-options-model.js';

import type { SlotView } from './slot-view.js';

export async function refreshSlotViewRecipeRunnerOptions(view: SlotView): Promise<void> {
  const project = view._linkedRun?.project ?? view._slot?.project ?? '';
  view._recipeRunnerUiOptions = await loadRecipeRunnerUiOptionsForProject(
    project,
    requestProjectConfigs,
  );
}

export const DEFAULT_SLOT_RECIPE_RUNNER_UI_OPTIONS: RecipeRunnerUiOptions =
  recipeRunnerUiOptions(null);
