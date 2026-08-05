// core/index.ts — Barrel export for core module

export type {
  ActiveRunSelectionOptions,
  ActiveRunSelectionResult,
  AmbiguityPolicy,
  MissingPointerPolicy,
} from './active-run-selection.js';
export {
  selectSingleActiveRunForSlot,
  SKIP_ACTIVE_RUN_SELECTION,
  sortActiveRunsNewestFirst,
} from './active-run-selection.js';
export type {
  ProjectVars,
  RawPoolJson,
  RawPoolSlot,
  RawProjectJson,
  ResolvedSlot,
  SlotVars,
  TaskPaths,
} from './config.js';
export {
  farmslotRoot,
  getOrchestratorTaskRoot,
  getProjectField,
  getProjectFieldRaw,
  isIgnoredPoolFile,
  isMissingProjectConfigError,
  isMockModeProject,
  loadProjectVars,
  loadSlotVars,
  poolDir,
  projectsDir,
  resolveProjectTaskDirName,
  resolveRemoteRepo,
  resolveSlot,
  resolveTaskPaths,
} from './config.js';
export type { ExecOnSlotOptions, ExecOptions, ExecResult } from './exec.js';
export { execArgvOnSlot, execFileArgv, execLocal, execOnSlot, isLocal } from './exec.js';
export {
  expandDispatchCmd,
  expandHook,
  expandPlatformField,
  expandRecycleCmd,
  expandTemplate,
  renderFixtureTemplate,
} from './hooks.js';
export { GatewayMethodError } from './method-error.js';
export { isPathInside } from './path.js';
export { applyProjectCommandEnv, buildProjectCommandEnvPrefix } from './project-env.js';
export { loadPromptTemplate } from './prompt-templates.js';
export type { LatestValidRecipeRunPointer } from './recipe-artifacts.js';
export { inferArtifactPurpose, sanitizeLatestValidRecipeRunPointer } from './recipe-artifacts.js';
export type { SlotLocality } from './slot-io.js';
export {
  slotCopyDir,
  slotCopyFile,
  slotFileExists,
  slotFileMtimeMs,
  slotListDir,
  slotReadFile,
  slotWatchFile,
  slotWriteFile,
  slotWriteFiles,
} from './slot-io.js';
export {
  claimSlotStatusIf,
  markSlotBusy,
  markSlotHeld,
  markSlotStatusIf,
  readSlotField,
  readSlotRow,
  resetSlot,
  resetSlotIf,
  rewriteStatusFile,
  SLOT_PHASE_RELEASING,
  slotOwnershipReleaseFields,
  transitionSlotStatus,
  updateSlotStatus,
  updateSlotStatusIf,
} from './state.js';
