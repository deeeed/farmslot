import type { ExecResult, SlotActionPlacement, SlotStatus } from '../contracts/index.js';
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
  prepareStatus: Methods.SLOT_PREPARE_STATUS,
  monitor: Methods.SLOT_MONITOR,
  show: Methods.SLOT_SHOW,
  softRefresh: Methods.SLOT_SOFT_REFRESH,
  reopen: Methods.SLOT_REOPEN,
  autoRefresh: Methods.SLOT_AUTO_REFRESH,
} as const;

/** One structured prepare sub-step (ADR-037) — phase, profile resolution, or
 * fallback reason. Mirrors the `slot.prepare.step` event payload. */
export interface PrepareStepRecord {
  name: string;
  detail: string;
}

export interface SlotPrepareStatusParams {
  slotId: string;
}

/** Snapshot of an in-flight gateway-mediated prepare, used to re-attach the UI
 * after a reload: `requestId` rebinds the live `slot.prepare.*` stream and
 * `steps` restores the history emitted before the reload. */
export interface SlotPrepareStatusResult {
  preparing: boolean;
  requestId?: string;
  steps: PrepareStepRecord[];
}

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

export type MergeMainStrategy = 'merge' | 'rebase';

export interface SlotPrepareParams {
  slotId: string;
  branch?: string;
  mergeMain?: boolean;
  /** Overrides project merge_main_strategy for this prepare (ADR-042). */
  mergeMainStrategy?: MergeMainStrategy;
  forceNewBranch?: boolean;
  flowType?: string;
  app?: string;
  /** Named domain overlay — forwarded to fixture sync as the `DOMAIN` compose variable. */
  domain?: string;
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
  /**
   * Operator-driven warm switch: when set, the slot's `current_run_id` is bound
   * to this run after a successful prepare, so resume / recipe-replay target it.
   * Pure association — no pipeline re-drive, unlike run.activateOnSlot. By
   * default the bind only applies to a free or self-owned slot; pass `rebind`
   * to take over a slot currently bound to a different (non-working) run.
   */
  bindRunId?: string;
  /**
   * Allow `bindRunId` to take over a slot currently bound to a different run
   * (operator picked this run from the slot-side loader). A slot with a live
   * worker (`agent === 'working'`) is never re-bound, even with this set.
   */
  rebind?: boolean;
  /**
   * When true, do not walk the project's prepare-profile fallback chain if
   * preconditions fail — fail fast with the check reason. Operator-initiated
   * flows (load-run, switch-branch) pass this so `attach` stays attach.
   */
  strictProfile?: boolean;
  /**
   * Skip all prepare phases and only bind `bindRunId` + sync recipe workflows.
   * Use when the slot is already on the target branch (load-run fast path).
   */
  bindOnly?: boolean;
  /**
   * Pre-allocated progress id. Gateway emits `script.output` / `script.complete`
   * keyed to this id (same contract as slot.refresh / slot.release).
   */
  requestId?: string;
}

export interface SlotPrepareResult {
  prepared: boolean;
  requestId: string;
  profile?: {
    selected: string;
    requested?: string;
    fallbacks: Array<{ from: string; to: string; reason: string }>;
  };
  startRef?: {
    resolvedSha: string;
    resolvedAt: string;
  };
}

export interface SlotReleaseParams {
  slotId: string;
  keepWarm?: boolean;
  keepWork?: boolean;
  skipArtifacts?: boolean;
  forceReset?: boolean;
  killTmux?: boolean;
  /**
   * Skip killing tmux role windows and runner processes. Used when the run-engine
   * holds the slot through a human gate and defers agent teardown to finalize.
   */
  preserveAgents?: boolean;
  /**
   * Detach active run ownership for explicit operator release. Internal run-engine
   * warm releases keep this false so finalize/CI steps can still read the slot.
   */
  detachRuns?: boolean;
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

// ─── Slot helper verbs (ports of monitor/show/soft-refresh/reopen/auto-refresh scripts) ───

export interface SlotMonitorParams {
  slotId: string;
}

/** Composed worker-progress report: TASK status + branch + agent/tmux state + token usage. */
export interface SlotMonitorResult {
  report: string;
}

export interface SlotShowParams {
  slotId: string;
  /** Pre-allocated progress id for the emulator-toggle output stream. */
  requestId?: string;
}

export interface SlotSoftRefreshParams {
  slotId: string;
  requestId?: string;
}

export interface SlotReopenParams {
  slotId: string;
  requestId?: string;
}

/** Result of a streamed slot side-effect verb (show/soft-refresh/reopen). */
export interface SlotCommandResult extends ExecResult {
  requestId: string;
}

export interface SlotAutoRefreshParams {
  slotId: string;
  action?: 'start' | 'stop';
}

export interface SlotAutoRefreshResult {
  action: 'start' | 'stop';
  /** tmux session name driving the auto-refresh monitor. */
  session: string;
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
