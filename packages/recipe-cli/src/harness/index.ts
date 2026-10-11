// Generic harness support shared by every host CLI (`farmslot-recipe`, product
// presets such as `mm-harness`): host identity, runtime paths, the resumability
// journal, the checkout lock, JSON streaming and colour output.
export {
  adapterChoices,
  type AdapterLibraryOptions,
  type AdapterLoadOptions,
  adapterPlugin,
  adapterPluginChecks,
  AdapterPluginError,
  type AdapterPluginErrorCode,
  adapterSelectionFailureOut,
  composeAdapter,
  type DeclaredAdapter,
  declaredAdapterIds,
  declaredAdapters,
  ensureAdapterLoaded,
  type LoadedAdapterPlugin,
  loadedAdapterPlugins,
  selectedAdapterId,
} from './adapter-plugins.js';
export {
  adapterDetectNext,
  adapterFlags,
  adapterForPlatform,
  assertAdapter,
  checkoutRemote,
  configureHarnessAdapters,
  type DeclaredDetect,
  detectAdapter,
  detectAdapterMatch,
  type DetectEntry,
  harnessAdapter,
  harnessAdapters,
  isPlatformTarget,
  pickDetected,
  undetectedAdapterMessage,
} from './adapters.js';
export {
  type ArtifactManifestEntry,
  indexArtifactManifest,
  readContainedJsonArtifact,
  writeContainedArtifact,
} from './artifact-files.js';
export {
  type ActionCapabilitySource,
  createRuntimeRecipeCatalog,
  type DescribedAction,
  describeManifestActions,
  type RecipeCatalog,
  type ResolvedActionManifest,
  type RuntimeRecipeCatalogOptions,
} from './catalog.js';
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
  booleanOption,
  type CliUsageError,
  type CliUsageErrorCode,
  type CommandContract,
  type ContractedCommand,
  type ContractFailures,
  contractOptions,
  contractPositionals,
  type ContractValidationOptions,
  type InvalidChoice,
  optionalValueOption,
  type OptionSpec,
  optionValues,
  type PositionalSpec,
  publicCommandTokens,
  validatePublicInvocation,
  valueOption,
} from './command-contract.js';
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
export { type CallCommandOptions, handleCall, handleCallHelp } from './commands/call.js';
export {
  type ChecklistCommandOptions,
  type ChecklistStepGate,
  handleChecklist,
} from './commands/checklist.js';
export { handleActions } from './commands/discover.js';
export {
  type DoctorAdvisorySection,
  type DoctorCommandOptions,
  doctorFixNextActions,
  type DoctorFixOptions,
  handleDoctor,
} from './commands/doctor.js';
export { handleExecutionTemplate } from './commands/execution-template.js';
export { handleLast } from './commands/last.js';
export { handleLaunch } from './commands/launch.js';
export {
  handlePrepare,
  type PrepareCommandOptions,
  type PrepareStep,
  type StatusDevice,
} from './commands/prepare.js';
export {
  handleRecipeQuality,
  type RecipeQualityCommandOptions,
} from './commands/recipe-quality.js';
export { handleReload } from './commands/reload.js';
export {
  type DeviceTargeting,
  handleRun,
  type RunCommandOptions,
  type RunPlanStep,
} from './commands/run.js';
export { handleStatus, type StatusCommandOptions } from './commands/status.js';
export {
  changedLines,
  formatDuration,
  handleStatusTaskView,
  renderAcceptanceLines,
  renderTaskView,
  runStatusWatch,
  type StatusWatchDeps,
  type StatusWatchOptions,
} from './commands/status-watch.js';
export { handleStop, type StopCommandOptions, type StoppedCompanion } from './commands/stop.js';
export { handleTaskInit, type TaskInitCommandOptions } from './commands/task-init.js';
export {
  assertConformanceReportCurrent,
  checkRecipeConformance,
  conformanceChecksPass,
  recipeConformanceIdentity,
  type RecipeConformanceOptions,
  writeRecipeConformanceReport,
} from './conformance.js';
export {
  authorizedProjectLibraries,
  type ConfiguredRecipeProject,
  contextPorts,
  formatHarnessContext,
  loadProjectProvider,
  type LoadProjectProviderOptions,
  type ProjectProvider,
  recipePackageRoot,
  resolveHarnessContext,
  type ResolveHarnessContextOptions,
  resolveProjectContext,
  type ResolveProjectContextOptions,
  runtimeContextOwned,
} from './context.js';
export {
  AdapterAmbiguousError,
  type AdapterCandidate,
  contextAdapter,
  type ContextPortName,
  type ContextSource,
  type DetectMatch,
  type HarnessContext,
  harnessContext,
  harnessContextField,
  ProjectBindingError,
  type ResolvedProjectBinding,
  type ResolvedProjectLibrary,
  setHarnessContext,
} from './context-state.js';
export {
  createDoctorReport,
  type DoctorCheck,
  type DoctorReport,
  type DoctorReportOptions,
  type RequiredDoctorChecks,
  requiredDoctorCheckSummary,
  type RunnerInstallKind,
  runnerInstallKind,
  type RunnerProvenance,
  runnerProvenance,
  type RunnerProvenanceOptions,
} from './doctor-report.js';
export {
  captureExecutionProvenance,
  type ExecutionProvenanceDrift,
  executionProvenanceDrift,
  type ExecutionProvenanceInput,
  type ExecutionProvenancePhase,
  type ExecutionProvenanceRecord,
  type ExecutionProvenanceSnapshot,
  fileFingerprint,
  ProvenanceDriftError,
  providerSourceSnapshot,
  type SourceProvenanceSnapshot,
  sourceSnapshot,
  writeExecutionProvenance,
} from './execution-provenance.js';
export {
  createHarnessCli,
  type HarnessCli,
  type HarnessCliOptions,
  type HarnessCliResult,
  type HarnessCommand,
  type HarnessHelp,
  type HarnessHelpGroup,
  type HelpPaint,
  type HiddenHarnessCommand,
  type PublicHarnessCommand,
} from './harness-cli.js';
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
  recipeEnvName,
  validateRelativeRecipePath,
  withRecipeSignals,
} from './host.js';
export { failStream, JsonStreamWriter } from './json-stream.js';
export {
  leafStartFailureMessage,
  missingShellLeafMessage,
  resolveLeafInvoke,
  shellLeafMissing,
} from './leaf-invoke.js';
export { gitLibraryProvenance } from './library-provenance.js';
export {
  liveAdapterProcessTimeoutMs,
  type LiveAdapterRun,
  type PreparedLiveAdapter,
  prepareLiveAdapterScript,
  resolveLiveAdapter,
  resolveTsxBin,
  runLiveAdapterScript,
} from './live-adapter-contract.js';
export { runNetworkCaptureAction } from './network-observation.js';
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
  PREPARE_PROGRESS_ARTIFACT,
  recipeHarnessPath,
  recipeHarnessRoot,
  recipeOutputRoots,
  recipeRuntimeDir,
  recipeRuntimePath,
} from './paths.js';
export {
  isRecipeExecution,
  parseProjectInvocation,
  type ProjectCommandInvocation,
} from './project-command.js';
export {
  type ProjectRecipeHost,
  type ProjectRecipeHostOptions,
  withProjectRecipeHost,
} from './project-host.js';
export {
  type DevicePreview,
  type FeatureFlagReport,
  type ReadinessViewOptions,
  renderFeatureFlagLine,
} from './readiness.js';
export {
  describeRunnableRecipe,
  listRunnableRecipes,
  type RecipeParameterSummary,
  resolveLibrarySources,
  runnableLibraryRecipes,
  type RunnableRecipe,
  type RunnableRecipeDetail,
} from './recipe-library.js';
export {
  type RunRecipeStaticValidation,
  validateActionInputs,
  validateCommandNodes,
  validateRunRecipeStatic,
} from './recipe-validation.js';
export {
  captureHelperPath,
  captureHelperSupportsCapability,
  captureHelperSupportsRecordSessionSnapshots,
  createRecordingTargetProvider,
} from './recording-target.js';
export {
  beginRunDiagnostics,
  type CaptureEvidence,
  type ClassifiedConsoleRecord,
  collectRunDiagnostics,
  type ConsoleAllowlist,
  type ConsoleAllowlistMatch,
  type ConsoleCaptureSpec,
  type ConsoleClassifier,
  type ConsoleEventKey,
  type ConsoleRecord,
  finishRunDiagnostics,
  formatRunDiagnosticsForHuman,
  readRunDiagnosticsDocument,
  type RecipeRunEvidence,
  type RunDiagnosticBaseline,
  type RunDiagnosticsDocument,
  type RunSideFinding,
  verifyConsoleCapture,
} from './run-diagnostics.js';
export {
  activateRecipeRuntimeEnvironment,
  countRecipeNodes,
  createDefaultRecipeEngine,
  type DefaultRecipeEngineOptions,
  preflightRecipe,
  type PreparedRecipeExecution,
  type RecipeEngine,
  type RecipeEngineRunOptions,
  type RecipeRunnerOptions,
  runRecipe,
  type TrustedMutationAuthorizeContext,
  type TrustedMutationLoadInput,
} from './run-engine.js';
export { recipeRunOptionsFromCli } from './run-options.js';
export {
  type ActiveRecipeRecording,
  captureActiveRecipeRecordingSnapshot,
  type RecipeRecordingOptions,
  startRecipeRecording,
  stopRecipeRecording,
} from './run-recording.js';
export {
  executedBrowser,
  indexProductProvenanceArtifact,
  recipeCdpPorts,
  type RunReport,
  writeRunReport,
  writeViolationReport,
} from './run-report.js';
export {
  type ProofDocument,
  type ProofNode,
  validateRuntimeProof,
  validateRuntimeProofPlan,
} from './runtime-proof.js';
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
export {
  createStageReporter,
  formatElapsed,
  type ReportedStage,
  stageProgressText,
  type StageReporter,
  type StageReporterOptions,
} from './stage-progress.js';
export { closest } from './suggest.js';
export {
  CHECKLIST_LABEL_LIMIT,
  collectTaskView,
  findTaskDir,
  TASK_SILENT_AFTER_MS,
  type TaskView,
  type TaskViewActivity,
  type TaskViewCheckout,
  type TaskViewCommand,
  type TaskViewFixture,
  type TaskViewHarness,
  type TaskViewIsolation,
  type TaskViewLibrary,
  type TaskViewPrepare,
  type TaskViewRow,
  type TaskViewSandbox,
  type TaskViewSignal,
  type TaskViewSubtask,
  type TaskViewSubtaskSource,
  type TaskViewTemplate,
} from './task-view.js';
export {
  explicitRecipeTrustOptions,
  type RecipeTrustFailure,
  recipeTrustFailure,
} from './trust.js';
