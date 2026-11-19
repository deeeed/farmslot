import {
  digestRecipeDocument,
  type RecipeInvocationTree,
  type RecipeResolutionDocument,
} from '@farmslot/protocol';

import type { ResolvedRecipeDependencies } from './compose.js';
import {
  buildRecipeInvocationTree,
  type BuildRecipeInvocationTreeInput,
  isRecipeWorkNode,
} from './flow.js';
import { RecipeResolutionError } from './resolution-error.js';

export interface RecipeStructuralInventoryInput extends Pick<
  BuildRecipeInvocationTreeInput,
  'root' | 'claimProjections'
> {
  dependencies: ResolvedRecipeDependencies;
}

export interface RecipeStructuralInventoryCounts {
  nodeCount: number;
  branchCount: number;
  callCount: number;
  recipeCount: number;
  teardownEntryCount: number;
}

/** Static resolved structure, independent of selected paths, run status or timing. */
export interface RecipeStructuralInventory {
  version: 1;
  resolution: RecipeResolutionDocument;
  tree: RecipeInvocationTree;
  counts: RecipeStructuralInventoryCounts;
}

export function buildRecipeStructuralInventory(
  input: RecipeStructuralInventoryInput,
): RecipeStructuralInventory {
  if (digestRecipeDocument(input.root) !== input.dependencies.document.root.digest) {
    throw new RecipeResolutionError(
      'RECIPE_RESOLUTION_DIGEST_MISMATCH',
      'Structural inventory root does not match its resolved source digest.',
      'reload the root document and resolve its dependencies together',
    );
  }
  const tree = buildRecipeInvocationTree({
    root: input.root,
    rootRef: input.dependencies.document.root.ref,
    recipes: input.dependencies.recipes,
    claimProjections: input.claimProjections,
  });
  for (const dependency of input.dependencies.document.dependencies) {
    const recipe = input.dependencies.recipes.get(dependency.ref);
    if (!recipe || digestRecipeDocument(recipe.document) !== dependency.digest) {
      throw new RecipeResolutionError(
        'RECIPE_RESOLUTION_DIGEST_MISMATCH',
        `Resolved recipe ${dependency.ref} does not match its source digest.`,
        'reload the recipe documents and resolve the dependency closure together',
      );
    }
  }
  const counts: RecipeStructuralInventoryCounts = {
    nodeCount: 0,
    branchCount: 0,
    callCount: 0,
    recipeCount: 0,
    teardownEntryCount: 0,
  };
  const recipeRefs = new Set<string>();
  for (const node of tree.nodes) {
    recipeRefs.add(node.recipeRef);
    if (node.teardown !== null) counts.teardownEntryCount++;
    if (node.id !== tree.rootId && node.action === 'call') counts.callCount++;
    if (!isRecipeWorkNode(node)) continue;
    counts.nodeCount++;
    if (Object.keys(node.cases).length > 0 || node.default !== null) counts.branchCount++;
  }
  counts.recipeCount = recipeRefs.size;
  return { version: 1, resolution: input.dependencies.document, tree, counts };
}
