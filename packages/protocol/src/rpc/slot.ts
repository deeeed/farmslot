import type { SlotActionPlacement, SlotStatus } from '../contracts/index.js';
import type { RecipeValidationResult } from '../recipe/index.js';

import { Methods } from './registry.js';

export const SlotMethods = {
  check: Methods.SLOT_CHECK,
  prepare: Methods.SLOT_PREPARE,
  release: Methods.SLOT_RELEASE,
  recycle: Methods.SLOT_RECYCLE,
  refresh: Methods.SLOT_REFRESH,
  cleanup: Methods.SLOT_CLEANUP,
  fixtureRefresh: Methods.SLOT_FIXTURE_REFRESH,
  runHistory: Methods.RUN_SLOT_HISTORY,
  forSlot: Methods.RUN_FOR_SLOT,
  recipeRunsForSlot: Methods.RUN_RECIPE_RUNS_FOR_SLOT,
  recipeRerun: Methods.RECIPE_RERUN,
  recipeCancel: Methods.RECIPE_CANCEL,
  recipeCommand: Methods.RECIPE_COMMAND,
  recipeProjectHookCommand: Methods.RECIPE_PROJECT_HOOK_COMMAND,
  recipeProjectHookRun: Methods.RECIPE_PROJECT_HOOK_RUN,
  actionList: Methods.SLOT_ACTION_LIST,
  actionRun: Methods.SLOT_ACTION_RUN,
} as const;

// Slot RPC also exposes slot-facing run helpers so callers can import one slot
// RPC contract module.
export type {
  SlotFixtureRefreshParams,
  SlotFixtureRefreshResult,
  SlotRunHistoryParams,
  SlotRunHistoryResult,
} from './run.js';

export interface SlotCheckParams {
  slotId: string;
}

export interface SlotPrepareParams {
  slotId: string;
  branch?: string;
  mergeMain?: boolean;
  forceNewBranch?: boolean;
  flowType?: string;
  app?: string;
  /**
   * Named prepare profile from the project's prepare.profiles (ADR-037).
   * Unset → prepare.default → implicit full. Unknown names fail the prepare.
   */
  prepareProfile?: string;
  /**
   * Project-scoped key/value pairs. Exported to the preflight hook as
   * `FARMSLOT_VAR_<UPPERCASE_KEY>` env vars. Framework does not interpret them —
   * projects define their own allowed keys/values.
   */
  vars?: Record<string, string>;
  /**
   * Optional run id of the run this prepare belongs to. Used to label tmux
   * prepare windows so an attached operator can correlate the prepare-<label>
   * window in the slot session to the run-detail page. Free-form when omitted —
   * a timestamp is used so window names stay unique across concurrent prepares.
   */
  runId?: string;
}

export interface SlotReleaseParams {
  slotId: string;
  keepWarm?: boolean;
  keepWork?: boolean;
  skipArtifacts?: boolean;
  forceReset?: boolean;
  killTmux?: boolean;
  /**
   * Optional client-scoped progress id. Slot action UIs pre-allocate this so
   * release/recycle progress can render through the same script.output /
   * script.complete stream as other long-running slot actions.
   */
  requestId?: string;
}

export interface SlotRecycleParams {
  slotId: string;
  forceReset?: boolean;
  /** Optional client-scoped progress id forwarded to the underlying slot.release call. */
  requestId?: string;
}

export interface SlotRefreshParams {
  slotId: string;
  /** safe (default) aborts on dirty tree or stale branch; force hard-resets through dirt. */
  mode?: 'safe' | 'force';
  /**
   * Pre-allocated request id. When provided, the gateway emits
   * script.output / script.complete keyed to this id and echoes it back in
   * the response. Letting the UI generate it client-side closes the race
   * where streaming events arrive before the UI knows which id to filter on.
   */
  requestId?: string;
}

export interface SlotRefreshResult {
  requestId: string;
  refreshed: boolean;
  /** When refreshed=false, why we aborted. */
  reason?: 'dirty' | 'stale';
  branch: string;
  /** True when origin/<branch> moved past the slot's prior HEAD. */
  advanced: boolean;
}
export interface SlotCleanupParams {
  slotId: string;
  reason: 'lifecycle-transition' | 'manual' | 'orphan-sweep';
}

export interface SlotCleanupResult {
  ok: true;
  cleaned: string[]; // resource IDs whose shutdown hooks fired
  skipped: string[]; // resource IDs that did not run (no hook, already stopped, etc.)
  skippedReason?: Record<string, string>; // resourceId -> reason
  storageDeleted?: string[]; // stale worker-side task/runtime cache directories removed
  storageSkippedReason?: Record<string, string>; // path/key -> reason
}
export interface SlotCheckResult {
  slot: SlotStatus;
  checks: Array<{ name: string; status: 'pass' | 'fail'; detail: string }>;
}

export interface ScriptActionResult {
  requestId: string;
  artifactRoot?: string;
  // Output streams via events
}

export interface RecipeRerunParams {
  runId: string;
  slotId: string;
  recipeArtifactPath?: string;
  recipeRunId?: string;
  playbackSlowMs?: number;
  recordVideo?: boolean;
}

export interface RecipeCancelParams {
  slotId: string;
  requestId: string;
}

export interface RecipeCommandParams {
  runId: string;
  slotId: string;
  recipeArtifactPath?: string;
  recipeRunId?: string;
  playbackSlowMs?: number;
  recordVideo?: boolean;
}

export interface RecipeCommandResult {
  command: string;
  artifactRoot: string;
  recipePath: string;
}

export interface RecipeCancelResult {
  cancelled: boolean;
  reason?: string;
}

export type RecipeProjectHookName = 'recipe_action_manifest' | 'recipe_doctor' | 'recipe_run';

export interface RecipeProjectHookCommandParams {
  project: string;
  slotId: string;
  hook: RecipeProjectHookName;
  recipePath?: string;
  artifactsDir?: string;
}

export interface RecipeProjectHookCommandResult {
  hook: RecipeProjectHookName;
  command: string;
}

export interface RecipeProjectHookRunParams extends RecipeProjectHookCommandParams {
  timeoutMs?: number;
}

export interface RecipeProjectHookValidationCheck {
  id: string;
  status: 'pass' | 'fail';
  message: string;
}

export interface RecipeProjectHookValidationResult {
  status: 'pass' | 'fail';
  checks: RecipeProjectHookValidationCheck[];
  recipe?: RecipeValidationResult;
}

export interface RecipeProjectHookRunResult {
  hook: RecipeProjectHookName;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  validation: RecipeProjectHookValidationResult;
}

export interface SlotActionListParams {
  slotId: string;
  placement?: SlotActionPlacement;
}

export interface SlotActionListResult {
  actions: import('../contracts/index.js').SlotActionSummary[];
}

export interface SlotActionRunParams {
  slotId: string;
  actionId: string;
}

export interface SlotActionRunResult {
  ok: boolean;
  detail?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  refresh?: import('../contracts/index.js').SlotActionRefreshTarget[];
}
