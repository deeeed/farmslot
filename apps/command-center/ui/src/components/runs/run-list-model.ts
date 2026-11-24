import {
  deriveRunLifecycleView,
  type FlowType,
  type Run,
  type RunListDecision,
  type RunListProjection,
  type RunListQuery,
  type RunListResult,
  type RunListRow,
  type RunStatus,
  slotMachineMap,
  type SlotStatus,
} from '@farmslot/protocol';
import { isSettledBlockedRun, selectRunList, TERMINAL_RUN_STATUSES } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import type { GlobalFilters } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';
import { compareInventoryValues, sortInventoryRows } from '../shared/work-inventory-table-model.js';

import { familyLearningTimeAgo } from './family-observability-run-detail-renderers.js';
import { type RunInventorySortKey, runInventorySortValue } from './run-list-inventory.js';
import type { RunLaneFilter, SortOption, StatusFilter, TabFilter } from './run-list-state.js';
import { formatElapsed, isEvalRun } from './run-utils.js';

/** Runs the gateway lets `run.archive` evict: terminal, or blocked with nothing left to advance. */
export function isArchivableRun(
  run: Pick<Run, 'status' | 'steps'> & { decisions?: ReadonlyArray<{ resolvedAt?: string }> },
): boolean {
  return TERMINAL_STATUSES.has(run.status) || isSettledBlockedRun(run);
}

export const TERMINAL_STATUSES = new Set<RunStatus>(TERMINAL_RUN_STATUSES);

/** The Active tab's runs before its local filters; the sidebar badge and list use the same set. */
export function activeRunsForGlobalFilters(
  runs: readonly RunListRow[],
  globalFilters: GlobalFilters,
  slots: readonly Pick<SlotStatus, 'slot' | 'machine'>[],
): RunListRow[] {
  return selectRunList(runs, {
    scope: 'active',
    projects: globalFilters.projects,
    machines: globalFilters.machines,
    slotMachines: slotMachineMap(slots),
  });
}

/** Flag a run after this much idle time outside an operator wait. */
export const RUN_STALE_AFTER_MS = 20 * 60_000;

export interface RunProgressSummary {
  /** Latest real progress: a step, a decision, a run start or CI-watch progress. */
  lastProgressAt: string;
  lastProgressAgo: string;
  kind: 'gate' | 'stale' | 'step' | 'none';
  /** What the run waits on or does now; empty for `none`. */
  text: string;
}

type ProgressRun = Pick<
  Run,
  | 'status'
  | 'statusChangedAt'
  | 'createdAt'
  | 'startedAt'
  | 'steps'
  | 'ciWatchState'
  | 'monitorState'
  | 'waitingForOperator'
> & {
  decisions: ReadonlyArray<RunListDecision>;
};

// When a held step stopped for the operator: its duration is stamped at the hold.
function heldAtMs(step: Run['steps'][number]): number {
  return step.startedAt && step.durationMs !== undefined
    ? Date.parse(step.startedAt) + step.durationMs
    : NaN;
}

// `updatedAt` moves on every write (tags, metrics, agent contexts), so it is not
// progress. Recovery can rewrite a running step's start, even on rows without
// a status transition. Count the recorded step progress or a durable boundary.
function lastProgressMs(run: ProgressRun): number {
  const stamps = [
    run.createdAt,
    run.startedAt,
    run.statusChangedAt,
    run.ciWatchState?.lastProgressAt,
    // Structured runner activity while the worker is monitored.
    run.monitorState?.lastStructuredProgressAt,
    ...run.steps.flatMap((step) => [
      step.lastProgressAt,
      step.status !== 'running' ? step.startedAt : undefined,
      step.completedAt,
    ]),
    ...run.decisions.flatMap((decision) => [decision.createdAt, decision.resolvedAt]),
  ].map((stamp) => (stamp ? Date.parse(stamp) : NaN));
  const held = run.steps.filter((step) => step.outputs?.awaitingOperator === true).map(heldAtMs);
  return Math.max(...[...stamps, ...held].filter(Number.isFinite));
}

/** A blocked run can still be stale after its worker has stopped. */
export function showsRunProgress(run: Pick<Run, 'status'>): boolean {
  return !TERMINAL_STATUSES.has(run.status);
}

/** Whether an active run is moving, waiting on the operator, or stale. */
export function runProgressSummary(
  run: ProgressRun,
  nowMs = Date.now(),
): RunProgressSummary | null {
  if (!showsRunProgress(run)) return null;
  const step = run.steps.find((item) => item.status === 'running');
  // A blocked run may have stopped at monitor after recording a worker finish.
  const signalStep =
    step ??
    (run.status === 'blocked'
      ? run.steps.filter((item) => item.status === 'done' || item.status === 'failed').at(-1)
      : undefined);
  const signal = signalStep?.name === 'monitor' ? signalStep.outputs?.workerSignal : undefined;
  const workerFinished =
    signal &&
    typeof signal === 'object' &&
    'status' in signal &&
    (signal.status === 'complete' || signal.status === 'done');
  const finishCue = step ? 'Worker finished; monitor has not advanced' : 'Worker finished';
  const lastMs = lastProgressMs(run);
  // Every run has createdAt; a record without one valid timestamp has no clock to show.
  if (!Number.isFinite(lastMs)) return null;
  const lastProgressAt = new Date(lastMs).toISOString();
  const lastProgressAgo = familyLearningTimeAgo(lastProgressAt, nowMs);
  const summary = (kind: RunProgressSummary['kind'], text: string) => ({
    lastProgressAt,
    lastProgressAgo,
    kind,
    text,
  });
  const pending = run.decisions.find((decision) => !decision.resolvedAt);
  // A blocked run's reason heads its detail; the list names what the run waits on.
  const activity = run.status === 'blocked' ? undefined : deriveRunLifecycleView(run).activityLabel;
  if ((run.waitingForOperator || run.status === 'needs-decision') && activity)
    return summary('gate', activity);
  if (pending) {
    const action = pending.actions.find((item) => item.style === 'primary') ?? pending.actions[0];
    return summary('gate', action ? `${pending.title} → ${action.label}` : pending.title);
  }
  // A finished interactive worker, or a pause, waits on the operator without a decision.
  if (step?.outputs?.awaitingOperator === true)
    return summary('gate', step.detail ?? 'Waiting for operator action');
  if (run.status === 'paused') return summary('gate', 'Paused');
  if (run.status === 'human-gating' || run.status === 'needs-decision')
    return summary('gate', activity ?? 'Waiting for a decision');
  // Blocked with nothing running or pending but not settled: an uncertain prompt
  // delivery or worker operation is held for the operator to reconcile.
  if (run.status === 'blocked' && !step && !isSettledBlockedRun(run)) {
    const held = run.steps.find((item) => item.status === 'failed');
    return summary('gate', held?.detail ?? 'Waiting for the operator to reconcile the worker');
  }
  if (nowMs - lastMs > RUN_STALE_AFTER_MS) {
    const elapsed = formatElapsed(lastProgressAt, nowMs);
    return summary(
      'stale',
      `Stale · no progress for ${elapsed}${workerFinished ? ` · ${finishCue}` : ''}`,
    );
  }
  if (isSettledBlockedRun(run)) return null;
  if (activity) return summary('step', activity);
  if (workerFinished) return summary('step', finishCue);
  return step
    ? summary('step', step.detail ? `${step.name}: ${step.detail}` : step.name)
    : summary('none', '');
}

export function runGradeColor(semantic: string): string {
  switch (semantic) {
    case 'good':
      return colors.statusOk;
    case 'ok':
      return colors.statusWarn;
    case 'bad':
      return colors.statusFail;
    default:
      return colors.textMuted;
  }
}

export interface FilterRunListInput {
  familyFilter: string;
  familyRuns: readonly RunListRow[] | null;
  tagFilter: string;
  tagRuns: readonly RunListRow[] | null;
  runs: readonly RunListRow[];
  globalFilters: GlobalFilters;
  /** Fleet slot to machine, for the machine filter. */
  slotMachines: ReadonlyMap<string, string>;
  tab: TabFilter;
  statusFilter: StatusFilter;
  flowFilter: FlowType | '';
  laneFilter: RunLaneFilter;
  searchQuery: string;
  sortBy: SortOption;
}

/** The filters a run list applies, apart from the rows it filters and their order. */
export type RunListFilters = Omit<FilterRunListInput, 'runs' | 'familyRuns' | 'tagRuns' | 'sortBy'>;

function runListQuery(input: RunListFilters): RunListQuery {
  return {
    scope: input.tab,
    projects: input.globalFilters.projects,
    machines: input.globalFilters.machines,
    slotMachines: input.slotMachines,
    status: input.tab === 'active' || input.statusFilter === 'all' ? undefined : input.statusFilter,
    flow: input.flowFilter || undefined,
    lane: input.laneFilter === 'product' ? undefined : input.laneFilter || undefined,
    tag: input.tagFilter,
    search: input.searchQuery,
  };
}

/**
 * Version lists: the collection's size and the filters' matches, counted from every live run's
 * projection, so the counts stay whole while a view holds fewer rows than it lists.
 */
export function countRunListProjections(
  projections: readonly RunListProjection[],
  input: RunListFilters,
): { total: number; filtered: number } {
  const matching = withoutHiddenEvals(selectRunList(projections, runListQuery(input)), input);
  return {
    total: projections.length,
    filtered: input.familyFilter
      ? matching.filter((run) => run.familyId === input.familyFilter).length
      : matching.length,
  };
}

/** The run list's observation, on its host for proofs and the reconnect baseline to read. */
export function runListObservationAttributes(observation: ResourceQueryState<RunListResult>): {
  'data-runs-status': string;
  'data-runs-observed-at': string;
} {
  return {
    'data-runs-status': observation.status,
    'data-runs-observed-at': String(observation.observedAt ?? ''),
  };
}

export function filterRunList(input: FilterRunListInput): readonly RunListRow[] {
  // Family and tag views are fetched once; live run updates land in `runs`.
  const live = new Map(input.runs.map((run) => [run.id, run]));
  const withLive = (runs: readonly RunListRow[]) => runs.map((run) => live.get(run.id) ?? run);
  let result: readonly RunListRow[] = input.familyFilter
    ? withLive(input.familyRuns ?? [])
    : input.tagFilter
      ? input.tagRuns
        ? withLive(input.tagRuns)
        : input.runs
      : input.runs;
  result = withoutHiddenEvals(selectRunList(result, runListQuery(input)), input);
  if (input.familyFilter) {
    return sortRunList(
      result.filter((run) => run.familyId === input.familyFilter),
      input.sortBy,
    );
  }
  return productRunsFirst(sortRunList(result, input.sortBy));
}

function withoutHiddenEvals<R extends Partial<Pick<RunListRow, 'lane'>>>(
  runs: readonly R[],
  input: Pick<RunListFilters, 'laneFilter'>,
): readonly R[] {
  return input.laneFilter === 'product' ? runs.filter((run) => !isEvalRun(run)) : runs;
}

/** Product runs keep their order ahead of eval runs, which keep theirs. A family view stays in run order. */
function productRunsFirst(runs: readonly RunListRow[]): readonly RunListRow[] {
  return [...runs.filter((run) => !isEvalRun(run)), ...runs.filter(isEvalRun)];
}

/** Grouped views keep the same rule: a family of only eval runs lists after product families. */
export function productFamiliesFirst<G extends { runs: readonly Pick<RunListRow, 'lane'>[] }>(
  groups: readonly G[],
): G[] {
  const evalFamily = (group: G) => group.runs.every(isEvalRun);
  return [...groups.filter((group) => !evalFamily(group)), ...groups.filter(evalFamily)];
}

function sortRunList(result: readonly RunListRow[], sortBy: SortOption): readonly RunListRow[] {
  switch (sortBy) {
    case 'oldest':
      return [...result].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'duration':
      return [...result].sort((a, b) => (b.metrics.durationMs ?? 0) - (a.metrics.durationMs ?? 0));
    case 'project':
    case 'project-desc':
    case 'flow':
    case 'flow-desc':
    case 'status':
    case 'status-desc': {
      // Preserve main's recency-aware secondary order (newest first on ties).
      const inventoryKey = inventoryKeyForSortOption(sortBy);
      const multiplier = sortBy.endsWith('-desc') ? -1 : 1;
      return [...result].sort((a, b) => {
        const primary = compareInventoryValues(
          runInventorySortValue(a, inventoryKey),
          runInventorySortValue(b, inventoryKey),
        );
        if (primary !== 0) return primary * multiplier;
        return b.createdAt.localeCompare(a.createdAt);
      });
    }
    case 'ref':
    case 'ref-desc':
    case 'slot':
    case 'slot-desc':
    case 'runner':
    case 'runner-desc':
    case 'updated':
    case 'updated-desc': {
      const inventoryKey = inventoryKeyForSortOption(sortBy);
      const direction = sortBy.endsWith('-desc') ? 'desc' : 'asc';
      return sortInventoryRows(
        result,
        (run) => runInventorySortValue(run, inventoryKey),
        direction,
        (run) => run.id,
      );
    }
    case 'grade': {
      const order: Record<string, number> = { good: 3, ok: 2, bad: 1 };
      return [...result].sort(
        (a, b) =>
          (order[b.humanGrade?.recipe_semantic ?? ''] ?? 0) -
          (order[a.humanGrade?.recipe_semantic ?? ''] ?? 0),
      );
    }
    default:
      return result;
  }
}

function inventoryKeyForSortOption(sortBy: SortOption): RunInventorySortKey {
  if (sortBy === 'status' || sortBy === 'status-desc') return 'status';
  if (sortBy === 'flow' || sortBy === 'flow-desc') return 'flow';
  if (sortBy === 'project' || sortBy === 'project-desc') return 'project';
  if (sortBy === 'ref' || sortBy === 'ref-desc') return 'ref';
  if (sortBy === 'slot' || sortBy === 'slot-desc') return 'slot';
  if (sortBy === 'runner' || sortBy === 'runner-desc') return 'runner';
  if (sortBy === 'updated' || sortBy === 'updated-desc') return 'updated';
  return 'updated';
}
