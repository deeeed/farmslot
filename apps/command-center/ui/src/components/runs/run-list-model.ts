import {
  deriveRunLifecycleView,
  type FlowType,
  type Run,
  type RunLane,
  type RunListProjection,
  type RunListQuery,
  type RunListResult,
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
import type { SortOption, StatusFilter, TabFilter } from './run-list-state.js';

/** Runs the gateway lets `run.archive` evict: terminal, or blocked with nothing left to advance. */
export function isArchivableRun(run: Pick<Run, 'status' | 'steps' | 'decisions'>): boolean {
  return TERMINAL_STATUSES.has(run.status) || isSettledBlockedRun(run);
}

export const TERMINAL_STATUSES = new Set<RunStatus>(TERMINAL_RUN_STATUSES);

/** The Active tab's runs before its local filters; the sidebar badge and list use the same set. */
export function activeRunsForGlobalFilters(
  runs: readonly Run[],
  globalFilters: GlobalFilters,
  slots: readonly Pick<SlotStatus, 'slot' | 'machine'>[],
): Run[] {
  return selectRunList(runs, {
    scope: 'active',
    projects: globalFilters.projects,
    machines: globalFilters.machines,
    slotMachines: slotMachineMap(slots),
  });
}

/** An unblocked run with no progress for this long is shown as stale. */
export const RUN_STALE_AFTER_MS = 60 * 60_000;

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
  | 'decisions'
  | 'ciWatchState'
  | 'monitorState'
  | 'waitingForOperator'
>;

// When a held step stopped for the operator: its duration is stamped at the hold.
function heldAtMs(step: Run['steps'][number]): number {
  return step.startedAt && step.durationMs !== undefined
    ? Date.parse(step.startedAt) + step.durationMs
    : NaN;
}

// `updatedAt` moves on every write (tags, metrics, agent contexts), so it is not
// progress. Neither is a running step's `startedAt`: a gateway restart re-enters
// the step and rewrites it. Its real start is a status change, the previous
// step's completion or the decision that released it; a Resume is a status change.
function lastProgressMs(run: ProgressRun): number {
  const stamps = [
    run.createdAt,
    run.startedAt,
    run.statusChangedAt,
    run.ciWatchState?.lastProgressAt,
    // Structured runner activity while the worker is monitored.
    run.monitorState?.lastStructuredProgressAt,
    ...run.steps.flatMap((step) =>
      step.status === 'running' ? [] : [step.startedAt, step.completedAt],
    ),
    ...run.decisions.flatMap((decision) => [decision.createdAt, decision.resolvedAt]),
  ].map((stamp) => (stamp ? Date.parse(stamp) : NaN));
  const held = run.steps.filter((step) => step.outputs?.awaitingOperator === true).map(heldAtMs);
  return Math.max(...[...stamps, ...held].filter(Number.isFinite));
}

/** Runs that can still move: not terminal, and not blocked with nothing left to advance. */
export function showsRunProgress(run: Pick<Run, 'status' | 'steps' | 'decisions'>): boolean {
  return !TERMINAL_STATUSES.has(run.status) && !isSettledBlockedRun(run);
}

/** Whether an active run is moving, waiting on the operator, or stale. */
export function runProgressSummary(
  run: ProgressRun,
  nowMs = Date.now(),
): RunProgressSummary | null {
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
  if (activity) return summary(run.status === 'fixing' ? 'step' : 'gate', activity);
  if (pending) {
    const action = pending.actions.find((item) => item.style === 'primary') ?? pending.actions[0];
    return summary('gate', action ? `${pending.title} → ${action.label}` : pending.title);
  }
  const step = run.steps.find((item) => item.status === 'running');
  // A finished interactive worker, or a pause, waits on the operator without a decision.
  if (step?.outputs?.awaitingOperator === true)
    return summary('gate', step.detail ?? 'Waiting for operator action');
  if (run.status === 'paused') return summary('gate', 'Paused');
  // Blocked with nothing running or pending but not settled: an uncertain prompt
  // delivery or worker operation is held for the operator to reconcile.
  if (run.status === 'blocked' && !step && !isSettledBlockedRun(run)) {
    const held = run.steps.find((item) => item.status === 'failed');
    return summary('gate', held?.detail ?? 'Waiting for the operator to reconcile the worker');
  }
  if (nowMs - lastMs >= RUN_STALE_AFTER_MS)
    return summary(
      'stale',
      `Stale: no progress for ${lastProgressAgo.replace(/ ago$/u, '')} and nothing pending`,
    );
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
  familyRuns: readonly Run[] | null;
  tagFilter: string;
  tagRuns: readonly Run[] | null;
  runs: readonly Run[];
  globalFilters: GlobalFilters;
  /** Fleet slot to machine, for the machine filter. */
  slotMachines: ReadonlyMap<string, string>;
  tab: TabFilter;
  statusFilter: StatusFilter;
  flowFilter: FlowType | '';
  laneFilter: RunLane | '';
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
    lane: input.laneFilter || undefined,
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
  const matching = selectRunList(projections, runListQuery(input));
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

export function filterRunList(input: FilterRunListInput): readonly Run[] {
  // Family and tag views are fetched once; live run updates land in `runs`.
  const live = new Map(input.runs.map((run) => [run.id, run]));
  const withLive = (runs: readonly Run[]) => runs.map((run) => live.get(run.id) ?? run);
  let result: readonly Run[] = input.familyFilter
    ? withLive(input.familyRuns ?? [])
    : input.tagFilter
      ? input.tagRuns
        ? withLive(input.tagRuns)
        : input.runs
      : input.runs;
  result = selectRunList(result, runListQuery(input));
  if (input.familyFilter) {
    result = result.filter((run) => run.familyId === input.familyFilter);
  }
  switch (input.sortBy) {
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
      const inventoryKey = inventoryKeyForSortOption(input.sortBy);
      const multiplier = input.sortBy.endsWith('-desc') ? -1 : 1;
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
      const inventoryKey = inventoryKeyForSortOption(input.sortBy);
      const direction = input.sortBy.endsWith('-desc') ? 'desc' : 'asc';
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
