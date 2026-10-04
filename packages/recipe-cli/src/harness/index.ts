// Generic harness support shared by every host CLI (`farmslot-recipe`, product
// presets such as `mm-harness`): host identity, runtime paths, the resumability
// journal, the checkout lock, JSON streaming and colour output.
export {
  adapterDetectNext,
  adapterFlags,
  adapterForPlatform,
  assertAdapter,
  configureHarnessAdapters,
  detectAdapter,
  harnessAdapter,
  harnessAdapters,
  isPlatformTarget,
  undetectedAdapterMessage,
} from './adapters.js';
export {
  type ArtifactManifestEntry,
  indexArtifactManifest,
  readContainedJsonArtifact,
  writeContainedArtifact,
} from './artifact-files.js';
export {
  acquireCheckoutLock,
  type CheckoutLock,
  type CheckoutLockFailure,
  trackCheckoutChild,
} from './checkout-lock.js';
export {
  classifyLogEvent,
  color,
  colorEnabled,
  colorHumanMessage,
  colorKv,
  colorLogEvent,
  colorStatusWord,
  stripAnsi,
} from './cli-color.js';
export {
  COMMAND_JOURNAL_FILE,
  commandJournalPath,
  type CommandJournalRecord,
  isSensitiveKey,
  readCommandJournal,
  recordCommandEvidence,
  recordCommandOutput,
  recordCommandStage,
  redactCommandArgs,
  redactStructuredValue,
  withCommandJournal,
} from './command-journal.js';
export { handleLast } from './commands/last.js';
export { handleLaunch } from './commands/launch.js';
export { handleReload } from './commands/reload.js';
export { handleStop, type StopCommandOptions, type StoppedCompanion } from './commands/stop.js';
export {
  checkHealBounds,
  classifyFailure,
  conciseFailureForHuman,
  ensureOverlay,
  type FailureClass,
  newHealState,
  parseHeal,
  recipeRunning,
} from './heal-bounds.js';
export {
  configureHarnessHost,
  type HarnessHost,
  harnessHost,
  type HarnessHostConfig,
  hostEnvName,
  validateRelativeRecipePath,
} from './host.js';
export { JsonStreamWriter } from './json-stream.js';
export {
  leafStartFailureMessage,
  missingShellLeafMessage,
  resolveLeafInvoke,
  shellLeafMissing,
} from './leaf-invoke.js';
export { gitLibraryProvenance } from './library-provenance.js';
export {
  argValue,
  handleHarness,
  type HarnessAction,
  hasArg,
  type OverlayCommandOptions,
  type OverlayInstallContext,
  readRuntimeContextField,
  resolveRuntimeContextPath,
} from './overlay.js';
export {
  actionManifestPathOption,
  adapterOption,
  applyRuntimeDirOption,
  applyWatcherPortOption,
  CliError,
  type CliOptions,
  type CliOptionValue,
  isRecord,
  optionFlag,
  optionString,
  optionStrings,
  parseArgs,
  type ParseArgsOptions,
  type ParsedArgs,
  parsePort,
  parseRecipeParamAssignments,
  requiredOption,
  resolveAdapter,
  shellQuote,
  shellQuoteArg,
  targetPath,
  usageError,
} from './parse-args.js';
export {
  DEFAULT_RECIPE_HARNESS_ROOT,
  DEFAULT_RECIPE_RUNTIME_DIR,
  harnessExecutable,
  recipeHarnessPath,
  recipeHarnessRoot,
  recipeRuntimeDir,
  recipeRuntimePath,
} from './paths.js';
export {
  checkoutBusyOut,
  EXIT,
  flag,
  type ParsedFlags,
  parseFlags,
  resolveFlagsAdapter,
  scriptOverride,
  type ScriptResult,
  spawnInherit,
  spawnScript,
  spawnScriptStreaming,
  str,
  type StreamingSpawnOptions,
  targetOf,
  usageOut,
  writeInteractiveProgress,
} from './shared.js';
