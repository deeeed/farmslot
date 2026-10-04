// Generic harness support shared by every host CLI (`farmslot-recipe`, product
// presets such as `mm-harness`): host identity, runtime paths, the resumability
// journal, the checkout lock, JSON streaming and colour output.
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
export {
  configureHarnessHost,
  type HarnessHost,
  harnessHost,
  hostEnvName,
  validateRelativeRecipePath,
} from './host.js';
export { JsonStreamWriter } from './json-stream.js';
export { missingShellLeafMessage, resolveLeafInvoke, shellLeafMissing } from './leaf-invoke.js';
export { gitLibraryProvenance } from './library-provenance.js';
export {
  DEFAULT_RECIPE_HARNESS_ROOT,
  DEFAULT_RECIPE_RUNTIME_DIR,
  harnessExecutable,
  recipeHarnessPath,
  recipeHarnessRoot,
  recipeRuntimeDir,
  recipeRuntimePath,
} from './paths.js';
