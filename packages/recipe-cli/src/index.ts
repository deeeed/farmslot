export {
  actionCapabilityMatrix,
  type ActionCapabilityRefusal,
  actionCategory,
  type ActionCategorySummary,
  type ActionMatrixRow,
  type ActionSupport,
  type AdapterActionCatalog,
  type CatalogAction,
  findRelatedActions,
  fuzzyResolveActions,
  missingActionCapabilities,
  resolveActionCapabilityRefusal,
  searchActions,
  shortActionNames,
  summarizeActionCategories,
} from './action-catalog.js';
export { createRecipeCliProgram, type RecipeCliOptions, runRecipeCli } from './cli.js';
export { type DiscoveryCommandContext, registerDiscoveryCommands } from './commands.js';
export { explainRecipe, type RecipeComposition, recipeComposition } from './composition.js';
export { DiscoveryError, type DiscoveryErrorCode } from './discovery-error.js';
export {
  assessRecipe,
  buildDiscoveryIndex,
  type DiscoveryOptions,
  findRecipe,
  type IndexedAction,
  type RecipeDiscoveryIndex,
  type RecipeReadinessView,
} from './discovery-index.js';
export {
  type DiscoveryLibraryOptions,
  PRECEDENCE_RULES,
  type ResolvedDiscoveryLibrary,
  resolveDiscoveryLibraries,
} from './libraries.js';
export { searchIndex } from './search.js';
export type * from './types.js';
export { DISCOVERY_SCHEMA_VERSION } from './types.js';
export { RECIPE_CLI_VERSION } from './version.js';
