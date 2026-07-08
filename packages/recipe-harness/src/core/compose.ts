import { collectFlows, type InlineFlow } from './flows.js';
import { isRecord } from './json.js';
import {
  createEffectiveFlowCatalog,
  loadRecipeLibraries,
  type ResolvedLibraryFlow,
} from './library.js';
import type { RecipeLibrarySource, RecipeLogger } from './types.js';

/**
 * Inlines every reachable flow into `flows`, yielding a self-contained recipe
 * whose `call.ref`s resolve without the recipe library. Returns the recipe
 * unchanged when it composes no flows.
 */
export function buildResolvedRecipe(
  recipe: unknown,
  flowCatalog: ReadonlyMap<string, InlineFlow>,
): unknown {
  if (!isRecord(recipe) || flowCatalog.size === 0) return recipe;
  return { ...recipe, flows: Object.fromEntries(flowCatalog) };
}

export interface ComposeRecipeOptions {
  projectRoot: string;
  recipeDir: string;
  /** Library sources whose flows count as resolvable, mirroring run resolution. */
  librarySources?: RecipeLibrarySource[];
  logger?: RecipeLogger;
}

export interface ComposeRecipeResult {
  /** The self-contained recipe with every reachable flow inlined under `flows`. */
  resolved: unknown;
  /** Number of flows inlined; 0 means the recipe composes nothing. */
  flowCount: number;
}

/**
 * Resolves a recipe's full flow composition — inline `flows`, `uses` catalogs,
 * and configured library sources, transitively — and returns the fully-composed,
 * self-contained recipe. Shared by the runner (executed path) and the CLI/CI
 * static resolve-check so both derive the same `resolved-recipe.json`.
 */
export async function composeRecipe(
  recipe: unknown,
  options: ComposeRecipeOptions,
): Promise<ComposeRecipeResult> {
  const recipeLocalFlows = await collectFlows(recipe, {
    projectRoot: options.projectRoot,
    recipeDir: options.recipeDir,
  });
  const resolution =
    options.librarySources && options.librarySources.length > 0
      ? await loadRecipeLibraries(options.librarySources, options.logger)
      : undefined;
  const usedLibraryFlows = new Map<string, ResolvedLibraryFlow>();
  const { catalog } = createEffectiveFlowCatalog(
    recipeLocalFlows,
    resolution,
    usedLibraryFlows,
    options.logger,
  );
  return { resolved: buildResolvedRecipe(recipe, catalog), flowCount: catalog.size };
}
