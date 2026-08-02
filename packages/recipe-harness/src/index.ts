export type {
  AppLifecycleCommand,
  AppLifecycleCommandRunner,
  AppLifecyclePlatform,
  AppLifecycleTarget,
  AppLifecycleTargetProvider,
  CreateAppLifecycleAdapterOptions,
} from './adapters/app-lifecycle.js';
export { createAppLifecycleAdapter, createAppLifecycleAdapters } from './adapters/app-lifecycle.js';
export { createStandardCoreAdapters } from './adapters/core.js';
export {
  type GestureAction,
  gestureDurationMs,
  gesturePhase,
  gesturePoints,
  gestureSegmentDuration,
  gestureTarget,
  type UiPoint,
} from './adapters/gesture.js';
export type {
  StandardUiAction,
  UiActionTransport,
  UiTransportControl,
  UiTransportResult,
} from './adapters/ui.js';
export {
  createStandardUiAdapters,
  normalizeUiTransportResult,
  STANDARD_UI_ACTIONS,
} from './adapters/ui.js';
export {
  type ResolvedRecipeDependencies,
  resolveRecipeDependencies,
  rootResolutionRef,
  validateRecipeDependencyParams,
} from './core/compose.js';
export { RecipeExecutionError } from './core/failure.js';
export type { RecipeLibraryResolution, ResolvedLibraryRecipe } from './core/library.js';
export {
  applyTaskLocalInvocationTrust,
  defaultRecipeLibrarySources,
  loadRecipeLibraries,
  parseRecipeLibraryPath,
  personalRecipeLibraryRoot,
  resolveRecipeLibrarySources,
} from './core/library.js';
export { RecipeResolutionError } from './core/resolution-error.js';
export { createRecipeRunner, defineActionAdapter } from './core/runner.js';
export {
  finalizeRecipeSuite,
  type FinalizeRecipeSuiteRequest,
  freezeRecipeSuiteScope,
  type RecipeSuiteFinalizeResult,
  type RecipeSuiteResolutionInput,
  type RecipeSuiteScopeSnapshot,
  type RecipeSuiteVerdictInput,
} from './core/suite.js';
export {
  buildRecipeExecutionPlan,
  enforceRecipeExecutionPlan,
  recipeSourceForRequest,
} from './core/trust.js';
export { RecipeTrustError } from './core/trust-error.js';
export { RECIPE_TRUST_ENV, resolveRecipeTrustInput } from './core/trust-input.js';
export type * from './core/types.js';
export type { CaptureHelperVideoRecorderOptions } from './recording/capture-helper.js';
export {
  createCaptureHelperVideoRecorder,
  errorMessage,
  manifestTarget,
} from './recording/capture-helper.js';
export type { CdpVideoRecorderOptions } from './recording/cdp-video-recorder.js';
export { createCdpVideoRecorder } from './recording/cdp-video-recorder.js';
export type {
  RecipeResolutionDependency,
  RecipeResolutionDocument,
  RecipeResolutionEdge,
} from '@farmslot/protocol';
