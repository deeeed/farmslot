export { createRecipeCliProgram, type RecipeCliOptions, runRecipeCli } from './cli.js';
export { type DiscoveryCommandContext, registerDiscoveryCommands } from './commands.js';
export { explainRecipe, type RecipeComposition, recipeComposition } from './composition.js';
export { DiscoveryError, type DiscoveryErrorCode } from './discovery-error.js';
export {
  buildDiscoveryIndex,
  type DiscoveryOptions,
  findRecipe,
  type IndexedAction,
  type RecipeDiscoveryIndex,
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
