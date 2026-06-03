// run-store.ts — In-memory Run cache + JSON file persistence
// Each run persisted as .runs/{id}.json

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type AgentContext,
  agentContextTaskFile,
  agentRoleLabel,
  contextIdFor,
  DEFAULT_DEV_INTERACTIVE_PROFILE,
  FLOW_STEPS,
  type FlowType,
  primaryRoleForFlow,
  prNumberFromRunInput,
  type Run,
  type RunCreateParams,
  type RunLane,
  type RunStatus,
  type RunStep,
  type RunStepStatus,
  signalFileForTask,
} from '@farmslot/protocol';

import { farmslotRoot, isValidSafetyTier } from '../fleet/state.js';
import { invalidateLiveRecipeContextMemo } from '../live-recipe/context.js';
import { invalidateRecipeRunGroupCache } from '../methods/filesystem.js';
import { normalizeStartRefRequest } from '../projects/start-ref-policy.js';
import {
  normalizeRunner,
  runnerDefaultModel,
  runnerDefaultSafetyTier,
} from '../runners/registry.js';

// ADR-023 shipped 2026-04-20. Runs persisted before this date have no
// safetyTier field and were executed under the pre-refactor hardcoded
// --dangerously-* posture. Load-time backfill preserves that posture so
// relaunch paths (self-review, ci-monitor) don't silently demote legacy
// runs to `sandboxed` and stall on approval prompts after an upgrade.
export const SAFETY_TIER_EPOCH_ISO = '2026-04-20T00:00:00Z';
const SAFETY_TIER_EPOCH = Date.parse(SAFETY_TIER_EPOCH_ISO);

/**
 * Returns the backfilled safety tier for a legacy run, or null if no
 * backfill applies. Pure helper — a run is "legacy" when it was created
 * before ADR-023 shipped AND has no safetyTier persisted. Post-epoch runs
 * may legitimately have `safetyTier: undefined` while in flight (FIND_SLOT
 * pins it later), so they are left alone.
 */
export function backfillLegacySafetyTier(
  run: Pick<Run, 'safetyTier' | 'createdAt'>,
): 'dangerous' | null {
  if (run.safetyTier !== undefined) return null;
  const createdAtMs = Date.parse(run.createdAt ?? '');
  if (!Number.isFinite(createdAtMs)) return null;
  if (createdAtMs >= SAFETY_TIER_EPOCH) return null;
  return 'dangerous';
}

export function shouldUseIsolatedRunsDir(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  if (env.NODE_TEST_CONTEXT) return true;
  return argv.some((arg) => /(?:^|[/\\])[^/\\]+\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(arg));
}

// Test isolation: when running under `node --test` or the repo's common
// `yarn exec tsx .../*.test.ts` command shape, redirect RUNS_DIR to a
// per-process temp dir so test fixtures cannot pollute the real .runs/.
// Manual override via FARMSLOT_RUNS_DIR for cases where you want a custom
// path (CI fixtures, integration harnesses, etc.).
function resolveRunsDir(): string {
  if (process.env.FARMSLOT_RUNS_DIR) return process.env.FARMSLOT_RUNS_DIR;
  if (shouldUseIsolatedRunsDir(process.env, process.argv)) {
    return path.join(os.tmpdir(), `farmslot-test-runs-${process.pid}`);
  }
  return path.join(farmslotRoot, '.runs');
}
const RUNS_DIR = resolveRunsDir();
const QUARANTINE_DIR = path.join(RUNS_DIR, 'quarantine');
const runs = new Map<string, Run>();

const ACTIVE_STATUSES: Set<RunStatus> = new Set([
  'created',
  'grading',
  'writing-task',
  'slot-finding',
  'preparing',
  'dispatching',
  'monitoring',
  'self-reviewing',
  'human-gating',
  'completing',
  'ci-watching',
  'paused',
  'blocked',
]);

export function resolveRunLane(
  mode?: RunCreateParams['mode'],
  lane?: RunCreateParams['lane'],
): RunLane {
  if (lane) return lane;
  if (mode === 'validation') return 'validation';
  return 'production';
}

export function normalizeRunClassification(
  params: Pick<RunCreateParams, 'mode' | 'lane' | 'variant'>,
): { lane: RunLane; variant: string | null } {
  const lane = resolveRunLane(params.mode, params.lane);
  const variant = params.variant?.trim() ? params.variant.trim() : null;
  if (lane === 'comparison' && !variant) {
    throw new Error('Comparison lane requires a variant label.');
  }
  if (lane !== 'comparison' && variant) {
    throw new Error(`Variant is only allowed for comparison lane runs (got lane=${lane}).`);
  }
  if (params.mode === 'validation' && lane !== 'validation') {
    throw new Error('Validation mode requires lane=validation.');
  }
  return { lane, variant };
}

function stepsForFlow(flowType: FlowType): RunStep[] {
  const steps = FLOW_STEPS[flowType] ?? FLOW_STEPS['fix-bug'];
  return steps.map((name) => ({ name, status: 'pending' as RunStepStatus }));
}

function initialAgentContextsForRun(
  run: Pick<
    Run,
    | 'id'
    | 'slotId'
    | 'flowType'
    | 'taskFile'
    | 'activeTaskFile'
    | 'metrics'
    | 'updatedAt'
    | 'status'
  >,
): AgentContext[] | undefined {
  if (!run.slotId) return undefined;
  const role = primaryRoleForFlow(run.flowType);
  const taskFile = agentContextTaskFile(run.taskFile, run.activeTaskFile);
  return [
    {
      id: contextIdFor(role),
      role,
      label: agentRoleLabel(role),
      status: run.status === 'paused' ? 'waiting' : 'working',
      slotId: run.slotId,
      runId: run.id,
      taskFile,
      signalFile: signalFileForTask(taskFile),
      runner: run.metrics.runner,
      model: run.metrics.model,
      target: null,
      runnerSessionId: run.metrics.runnerSessionId,
      runnerSessionPath: run.metrics.runnerSessionPath,
      nudgeCount: run.metrics.nudgeCount,
      updatedAt: run.updatedAt,
    },
  ];
}

async function ensureDir(): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
}

async function persist(run: Run): Promise<void> {
  await ensureDir();
  const filePath = path.join(RUNS_DIR, `${run.id}.json`);
  if (runs.get(run.id) !== run) return;
  // Atomic write: tmp + rename. Crash mid-write leaves the prior file intact instead
  // of truncating it — recoverActiveRuns can keep hydrating on restart.
  // Tmp suffix includes pid + random to avoid collisions across concurrent writers
  // (same reason ea0e8f6 scoped fleet-cache tmp files).
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmpPath, JSON.stringify(run, null, 2), 'utf-8');
  if (runs.get(run.id) !== run) {
    try {
      await unlink(tmpPath);
    } catch (err) {
      console.warn(
        `[run-store] failed to remove stale temp file ${tmpPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  await rename(tmpPath, filePath);
}

function persistRunBackground(run: Run, reason: string): void {
  void persist(run).catch((err) => {
    console.warn(
      `[run-store] failed to persist run ${run.id} after ${reason}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// Synthetic-run detector. Test fixtures call createRun() directly, which
// writes to the shared RUNS_DIR. When `t.after(cleanupRun)` hooks don't fire
// (test crash, abort, process kill) the fixtures stay on disk forever. The
// shape is unambiguous: status=done with no slot, no runner, every step still
// pending, no task files/PR/decisions, and near-zero lifetime. Quarantine these
// instead of silently deleting possible evidence.
export function isSyntheticLeak(run: Run): boolean {
  if (run.status !== 'done') return false;
  if (run.slotId !== null && run.slotId !== undefined) return false;
  if (run.metrics?.runner) return false;
  if (run.taskFile || run.activeTaskFile) return false;
  if (run.prNumber !== undefined && run.prNumber !== null) return false;
  if ((run.decisions ?? []).length > 0) return false;
  if (run.steps.length === 0 || !run.steps.every((s) => s.status === 'pending')) return false;
  if (!run.createdAt || !run.completedAt) return false;
  const createdAt = Date.parse(run.createdAt);
  const completedAt = Date.parse(run.completedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(completedAt)) return false;
  return completedAt >= createdAt && completedAt - createdAt <= 5 * 60 * 1000;
}

function syntheticLeakPurgeEnabled(): boolean {
  return process.env.FARMSLOT_PURGE_SYNTHETIC_LEAKS === '1';
}

async function quarantineRunFile(id: string, filePath: string, run?: Run): Promise<void> {
  await mkdir(QUARANTINE_DIR, { recursive: true });
  const dst = path.join(QUARANTINE_DIR, `${id}-${Date.now()}.json`);
  try {
    await rename(filePath, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!run) throw err;
    // The source file was already moved or removed; preserve the latest in-memory snapshot.
    await writeFile(dst, JSON.stringify(run, null, 2), 'utf-8');
  }
  console.warn(`[run-store] quarantined synthetic/leaked run ${id} -> ${dst}`);
}

export async function loadAllRuns(): Promise<void> {
  await ensureDir();
  let files: string[];
  try {
    files = await readdir(RUNS_DIR);
  } catch {
    return;
  }
  let quarantined = 0;
  let skippedSynthetic = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    if (file.includes('.tmp.')) continue; // stray atomic-write artifacts
    try {
      const filePath = path.join(RUNS_DIR, file);
      const raw = await readFile(filePath, 'utf-8');
      const run: Run = JSON.parse(raw);
      if (isSyntheticLeak(run)) {
        if (syntheticLeakPurgeEnabled()) {
          await quarantineRunFile(run.id, filePath, run);
          quarantined++;
          continue;
        }
        skippedSynthetic++;
      }
      let changed = false;
      // Migrate legacy 'feature' flowType to 'dev'
      if ((run as any).flowType === 'feature') {
        run.flowType = 'dev' as any;
        changed = true;
      }
      if (!run.familyId) {
        run.familyId = run.id;
        changed = true;
      }
      if (run.parentRunId === undefined) {
        run.parentRunId = null;
        changed = true;
      }
      if (!run.familyRootTicketOrPr) {
        run.familyRootTicketOrPr = run.ticketOrPr;
        changed = true;
      }
      if (!(run as any).lane) {
        (run as Run).lane = run.mode === 'validation' ? 'validation' : 'production';
        changed = true;
      }
      if ((run as any).variant === undefined) {
        (run as Run).variant = null;
        changed = true;
      }
      for (const decision of run.decisions ?? []) {
        if (decision.type !== 'retrospective') continue;
        let decisionChanged = false;
        decision.actions = decision.actions.map((action) => {
          if (action.id === 'accept' && action.label !== 'Accept for Learning') {
            decisionChanged = true;
            return { ...action, label: 'Accept for Learning' };
          }
          if (action.id === 'rework' && action.label !== 'Reject Learning') {
            decisionChanged = true;
            return { ...action, label: 'Reject Learning' };
          }
          return action;
        });
        if (decisionChanged) changed = true;
      }
      const legacyTier = backfillLegacySafetyTier(run);
      if (legacyTier !== null) {
        run.safetyTier = legacyTier;
        changed = true;
      }
      if (run.agentContexts === undefined && ACTIVE_STATUSES.has(run.status)) {
        const agentContexts = initialAgentContextsForRun(run);
        if (agentContexts) {
          run.agentContexts = agentContexts;
          changed = true;
        }
      }
      runs.set(run.id, run);
      if (changed) {
        persistRunBackground(run, 'load migration');
      }
    } catch {
      console.warn(`[run-store] failed to load ${file}`);
    }
  }
  if (quarantined > 0) console.log(`[run-store] quarantined ${quarantined} synthetic/leaked runs`);
  if (skippedSynthetic > 0)
    console.warn(
      `[run-store] found ${skippedSynthetic} synthetic/leaked run(s); set FARMSLOT_PURGE_SYNTHETIC_LEAKS=1 and restart to quarantine them`,
    );
  console.log(`[run-store] loaded ${runs.size} runs from disk`);
}

export function createRun(params: RunCreateParams): Run {
  if (Array.isArray(params.allowedSlots) && params.allowedSlots.length === 0) {
    throw new Error('Cannot create run: active slot filters resolved to no matching slots');
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const familyId = params.familyId ?? id;
  const { lane, variant } = normalizeRunClassification(params);
  const startRef = normalizeStartRefRequest(params);
  // Only pin a concrete safetyTier at create time when the runner is already
  // decided — either explicitly via params.runner, or implicitly by explicit
  // params.safetyTier. Deferred-runner runs (no params.runner) would otherwise
  // lock in Claude's fallback tier, then later FIND_SLOT can promote to a
  // different runner (e.g. Codex) whose default tier wouldn't be honored. In
  // that case, FIND_SLOT resolves the tier once the runner is chosen.
  const runnerExplicit = typeof params.runner === 'string' && params.runner.trim() !== '';
  // Reject invalid safetyTier values at the boundary — params come from
  // WebSocket JSON where the type system can't enforce SafetyTier. An
  // unrecognized string would silently flow through to flag resolution and
  // fall back to the runner default without logging the user's mistake.
  if (params.safetyTier !== undefined && !isValidSafetyTier(params.safetyTier)) {
    throw new Error(`Invalid safetyTier: ${String(params.safetyTier)}`);
  }
  const tierExplicit = params.safetyTier !== undefined;
  const resolvedTier = tierExplicit
    ? params.safetyTier
    : runnerExplicit
      ? runnerDefaultSafetyTier(normalizeRunner(params.runner))
      : undefined;
  const normalizedRunner = runnerExplicit ? normalizeRunner(params.runner) : null;
  const resolvedModel =
    params.model && params.model !== 'unknown'
      ? params.model
      : normalizedRunner
        ? runnerDefaultModel(normalizedRunner)
        : null;
  const devInteractiveProfile =
    params.flowType === 'dev' && params.mode === 'interactive'
      ? (params.devInteractiveProfile ?? DEFAULT_DEV_INTERACTIVE_PROFILE)
      : undefined;
  const engineState: Run['engineState'] =
    params.reviewDepth ||
    params.pendingReviewPlan?.length ||
    devInteractiveProfile ||
    params.initialContext ||
    params.devChecklist?.length
      ? {
          ...params.engineState,
          ...(params.reviewDepth || params.pendingReviewPlan?.length
            ? {
                publishGate: {
                  ...params.engineState?.publishGate,
                  ...(params.reviewDepth ? { reviewDepth: params.reviewDepth } : {}),
                  ...(params.pendingReviewPlan?.length
                    ? { pendingReviewPlan: params.pendingReviewPlan }
                    : {}),
                },
              }
            : {}),
          ...(devInteractiveProfile || params.initialContext || params.devChecklist?.length
            ? {
                interactiveDev: {
                  ...params.engineState?.interactiveDev,
                  ...(devInteractiveProfile ? { profile: devInteractiveProfile } : {}),
                  ...(params.initialContext ? { initialContext: params.initialContext } : {}),
                  ...(params.devChecklist?.length ? { checklist: params.devChecklist } : {}),
                },
              }
            : {}),
        }
      : params.engineState;
  const run: Run = {
    id,
    familyId,
    parentRunId: params.parentRunId ?? null,
    familyRootTicketOrPr: params.familyRootTicketOrPr ?? params.ticketOrPr,
    lane,
    variant,
    taskTemplate: params.taskTemplate ? { ...params.taskTemplate } : undefined,
    flowType: params.flowType,
    mode: params.mode,
    devInteractiveProfile,
    status: 'created',
    project: params.project,
    ticketOrPr: params.ticketOrPr,
    app: params.app,
    effort: params.effort,
    slotId: params.slotId ?? null,
    branch: params.branch ?? null,
    completionPolicy: params.completionPolicy,
    startRef,
    prNumber: startRef ? undefined : (prNumberFromRunInput(params) ?? undefined),
    allowedSlots:
      Array.isArray(params.allowedSlots) && params.allowedSlots.length > 0
        ? [...params.allowedSlots]
        : null,
    backlogItemId: params.backlogItemId,
    taskFile: params.taskFile ?? null,
    steps: stepsForFlow(params.flowType),
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: resolvedModel,
      runner: params.runner ?? null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    reviewTier: params.reviewTier,
    safetyTier: resolvedTier,
    engineState,
    ticketData: params.ticketData,
    createdAt: now,
    updatedAt: now,
  };
  run.agentContexts = initialAgentContextsForRun(run);
  runs.set(run.id, run);
  persistRunBackground(run, 'create');
  return run;
}

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function getAllRuns(): Run[] {
  return [...runs.values()];
}

export interface ListRunsFilter {
  status?: RunStatus;
  active?: boolean;
  limit?: number;
  flowType?: FlowType;
  project?: string;
  prNumber?: number;
  familyId?: string;
  lane?: RunLane;
  variant?: string | null;
  outcome?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: 'newest' | 'oldest' | 'duration' | 'grade';
}

export interface SlotRunHistoryFilter {
  limit?: number;
}

const SLOT_RUN_HISTORY_DEFAULT_LIMIT = 25;
const SLOT_RUN_HISTORY_MAX_LIMIT = 100;

export function runRecordPath(runId: string): string {
  return path.join(RUNS_DIR, `${runId}.json`);
}

export function listRunsForSlotHistory(
  slotId: string,
  filter?: SlotRunHistoryFilter,
): { runs: Run[]; totalCount: number } {
  const trimmedSlotId = slotId.trim();
  let result = [...runs.values()]
    .filter((r) => r.slotId === trimmedSlotId)
    .sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    });

  const totalCount = result.length;
  const requestedLimit = filter?.limit ?? SLOT_RUN_HISTORY_DEFAULT_LIMIT;
  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
    throw new Error('slot history limit must be a positive finite number');
  }
  const limit = Math.min(SLOT_RUN_HISTORY_MAX_LIMIT, Math.floor(requestedLimit));
  result = result.slice(0, limit);
  return { runs: result, totalCount };
}

export function listRuns(filter?: ListRunsFilter): { runs: Run[]; totalCount: number } {
  let result = [...runs.values()];

  if (filter?.status) {
    result = result.filter((r) => r.status === filter.status);
  } else if (filter?.active) {
    result = result.filter((r) => ACTIVE_STATUSES.has(r.status));
  }

  if (filter?.flowType) {
    result = result.filter((r) => r.flowType === filter.flowType);
  }
  if (filter?.project) {
    result = result.filter((r) => r.project === filter.project);
  }
  if (filter?.prNumber != null) {
    result = result.filter((r) => r.prNumber === filter.prNumber);
  }
  if (filter?.familyId) {
    result = result.filter((r) => r.familyId === filter.familyId);
  }
  if (filter?.lane) {
    result = result.filter((r) => r.lane === filter.lane);
  }
  if (filter?.variant !== undefined) {
    result = result.filter((r) => (r.variant ?? null) === (filter.variant ?? null));
  }
  if (filter?.outcome) {
    result = result.filter((r) => r.metrics.outcome === filter.outcome);
  }
  if (filter?.dateFrom) {
    result = result.filter((r) => r.createdAt >= filter.dateFrom!);
  }
  if (filter?.dateTo) {
    result = result.filter((r) => r.createdAt <= filter.dateTo!);
  }
  if (filter?.search) {
    const q = filter.search.toLowerCase();
    result = result.filter(
      (r) => r.ticketOrPr.toLowerCase().includes(q) || r.summary?.toLowerCase().includes(q),
    );
  }

  const totalCount = result.length;

  const sort = filter?.sort ?? 'newest';
  switch (sort) {
    case 'oldest':
      result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      break;
    case 'duration':
      result.sort((a, b) => (b.metrics.durationMs ?? 0) - (a.metrics.durationMs ?? 0));
      break;
    case 'grade': {
      const gradeOrder: Record<string, number> = { good: 3, ok: 2, bad: 1 };
      result.sort(
        (a, b) =>
          (gradeOrder[b.humanGrade?.recipe_semantic ?? ''] ?? 0) -
          (gradeOrder[a.humanGrade?.recipe_semantic ?? ''] ?? 0),
      );
      break;
    }
    default:
      result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const limit =
    filter?.limit ?? (filter?.familyId || filter?.prNumber != null ? result.length : 500);
  return { runs: result.slice(0, limit), totalCount };
}

export function updateRun(id: string, partial: Partial<Run>): Run {
  const run = runs.get(id);
  if (!run) throw new Error(`Run not found: ${id}`);

  const shouldInvalidateRecipeRunGroups =
    (Object.prototype.hasOwnProperty.call(partial, 'liveRecipeContext') &&
      !isDeepStrictEqual(partial.liveRecipeContext ?? null, run.liveRecipeContext ?? null)) ||
    (Object.prototype.hasOwnProperty.call(partial, 'taskFile') &&
      partial.taskFile !== run.taskFile) ||
    (Object.prototype.hasOwnProperty.call(partial, 'slotId') && partial.slotId !== run.slotId) ||
    (Object.prototype.hasOwnProperty.call(partial, 'project') && partial.project !== run.project);
  Object.assign(run, partial, { updatedAt: new Date().toISOString() });
  if (shouldInvalidateRecipeRunGroups) {
    invalidateRecipeRunGroupCache(id);
  }
  // Invalidate the per-run live-recipe-context memo only when fields that
  // affect what attachLiveRecipeContext reads from disk actually change.
  // Hot-path mutations (engineState, ciWatchState, monitorState, status flips,
  // bumpRunGeneration, mutateDedup ticks) do NOT touch artifact files, so
  // invalidating on those would defeat the memo's whole purpose — the
  // 4-9 callers fanning out per panel-open burst would each redo the load
  // every time a step ticked through. The fields below are the ones that
  // genuinely change the disk-resolution path or the recipe context payload.
  //
  // ⚠ MAINTAINERS: if loadLiveRecipeContextForRun ever starts reading another
  // Run field, ADD IT HERE. The first 4 mirror LiveRecipeReadCtx
  // (live-recipe-context.ts) — that's the canonical surface for disk-affecting
  // fields. Without this list staying in sync, mutations to the new field
  // would silently leave the memo serving stale data for up to 1s.
  const memoInvalidatingFields: Array<keyof Run> = [
    'liveRecipeContext',
    'taskFile',
    'slotId',
    'project',
    'prNumber',
    'branch',
    'flowType',
    'familyId',
  ];
  if (
    memoInvalidatingFields.some((field) => Object.prototype.hasOwnProperty.call(partial, field))
  ) {
    invalidateLiveRecipeContextMemo(id);
  }
  persistRunBackground(run, 'update');
  return run;
}

export function updateRunAgentContexts(
  id: string,
  mutator: (run: Run, contexts: AgentContext[]) => AgentContext[],
): Run {
  const run = runs.get(id);
  if (!run) throw new Error(`Run not found: ${id}`);
  const currentContexts =
    run.agentContexts && run.agentContexts.length > 0
      ? run.agentContexts
      : (initialAgentContextsForRun(run) ?? []);
  return updateRun(id, { agentContexts: mutator(run, currentContexts) });
}

export function updateRunStep(id: string, stepName: string, partial: Partial<RunStep>): Run {
  const run = runs.get(id);
  if (!run) throw new Error(`Run not found: ${id}`);

  const step = run.steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`Step not found: ${stepName}`);

  Object.assign(step, partial);
  run.updatedAt = new Date().toISOString();
  persistRunBackground(run, 'step update');
  return run;
}

export async function deleteRun(id: string): Promise<boolean> {
  const run = runs.get(id);
  if (!run) return false;
  if (ACTIVE_STATUSES.has(run.status)) {
    throw new Error(`Cannot delete active run ${id} (status=${run.status})`);
  }
  if (run.decisions?.some((d) => d.type === 'improvement' && !d.resolvedAt)) {
    console.warn(`[run-store] deleting run ${id} with unresolved improvement decision(s)`);
  }
  runs.delete(id);
  try {
    await unlink(path.join(RUNS_DIR, `${id}.json`));
  } catch {
    /* file may not exist */
  }
  return true;
}

const ARCHIVE_DIR = path.join(RUNS_DIR, 'archive');

export async function archiveRun(id: string): Promise<boolean> {
  const run = runs.get(id);
  if (!run) return false;
  if (ACTIVE_STATUSES.has(run.status)) {
    throw new Error(`Cannot archive active run ${id} (status=${run.status})`);
  }
  runs.delete(id);
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const src = path.join(RUNS_DIR, `${id}.json`);
  const dst = path.join(ARCHIVE_DIR, `${id}.json`);
  try {
    await rename(src, dst);
  } catch {
    // If rename fails (file missing), write directly to archive
    await writeFile(dst, JSON.stringify(run, null, 2), 'utf-8');
  }
  return true;
}

export async function bulkDeleteRuns(ids: string[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    const ok = await deleteRun(id);
    if (ok) deleted++;
  }
  return deleted;
}

const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function cleanupRuns(
  dryRun: boolean,
): Promise<{ taskDirsRemoved: string[]; runsArchived: string[]; syntheticRunsDeleted: string[] }> {
  const taskDirsRemoved: string[] = [];
  const runsArchived: string[] = [];
  const syntheticRunsDeleted: string[] = [];
  const now = Date.now();

  // Delete leaked test fixtures. They never represented real worker execution,
  // so archiving them would only move noisy data elsewhere.
  for (const [id, run] of runs) {
    if (!isSyntheticLeak(run)) continue;
    syntheticRunsDeleted.push(id);
    if (!dryRun) {
      const filePath = path.join(RUNS_DIR, `${id}.json`);
      await quarantineRunFile(id, filePath, run);
      runs.delete(id);
    }
  }

  // Scan for failed/cancelled runs older than 7 days → archive
  for (const [id, run] of runs) {
    if (run.status !== 'failed' && run.status !== 'cancelled') continue;
    const age = now - new Date(run.updatedAt).getTime();
    if (age < CLEANUP_AGE_MS) continue;
    runsArchived.push(id);
    if (!dryRun) {
      await archiveRun(id);
    }
  }

  // Scan task dirs for orphaned tasks from failed/cancelled runs
  const projectsDir = path.join(farmslotRoot, 'projects');
  let projectNames: string[] = [];
  try {
    projectNames = await readdir(projectsDir);
  } catch {
    /* no projects dir */
  }

  for (const proj of projectNames) {
    const tasksDir = path.join(projectsDir, proj, 'tasks');
    let taskDirs: string[];
    try {
      taskDirs = await readdir(tasksDir);
    } catch {
      continue;
    }

    for (const td of taskDirs) {
      const taskPath = path.join(tasksDir, td);
      const taskStat = await stat(taskPath).catch(() => null);
      if (!taskStat?.isDirectory()) continue;

      // Check if any run references this task dir
      const matchingRun = [...runs.values()].find(
        (r) => r.taskFile && path.dirname(r.taskFile) === taskPath,
      );
      if (matchingRun && (matchingRun.status === 'failed' || matchingRun.status === 'cancelled')) {
        taskDirsRemoved.push(taskPath);
        if (!dryRun) {
          // Remove task dir recursively
          const { rm } = await import('node:fs/promises');
          try {
            await rm(taskPath, { recursive: true, force: true });
          } catch (err) {
            console.warn(
              `[run-store] failed to remove task dir ${taskPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  }

  return { taskDirsRemoved, runsArchived, syntheticRunsDeleted };
}
