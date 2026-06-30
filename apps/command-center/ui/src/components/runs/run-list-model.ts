import type { FlowType, Run, RunLane, RunStatus } from '@farmslot/protocol';
import { TERMINAL_RUN_STATUSES } from '@farmslot/protocol';

import type { GlobalFilters } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';

import type { SortOption, StatusFilter, TabFilter } from './run-list-state.js';
import { dispositionLabel } from './run-utils.js';

export const TERMINAL_STATUSES = new Set<RunStatus>(TERMINAL_RUN_STATUSES);

/** Matches Runs list "Active" tab — non-terminal runs, with failed kept visible. */
export function isRunListActiveRun(run: Pick<Run, 'status'>): boolean {
  return !TERMINAL_STATUSES.has(run.status) || run.status === 'failed';
}

function runMatchesMachineFilter(slotId: string | null | undefined, machines: string[]): boolean {
  if (machines.length === 0) return true;
  const normalized = slotId?.trim();
  if (!normalized) return false;
  return machines.some((machine) => normalized === machine || normalized.startsWith(`${machine}-`));
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
  tab: TabFilter;
  statusFilter: StatusFilter;
  flowFilter: FlowType | '';
  laneFilter: RunLane | '';
  searchQuery: string;
  sortBy: SortOption;
}

export function filterRunList(input: FilterRunListInput): readonly Run[] {
  let result: readonly Run[] = input.familyFilter
    ? (input.familyRuns ?? [])
    : input.tagFilter
      ? (input.tagRuns ?? input.runs)
      : input.runs;
  if (input.globalFilters.projects.length > 0) {
    result = result.filter((run) => input.globalFilters.projects.includes(run.project));
  }
  if (input.globalFilters.machines.length > 0) {
    result = result.filter((run) =>
      runMatchesMachineFilter(run.slotId, input.globalFilters.machines),
    );
  }
  if (input.tab === 'active') {
    result = result.filter((run) => isRunListActiveRun(run));
  }
  if (input.tab === 'history') {
    result = result.filter((run) => TERMINAL_STATUSES.has(run.status));
  }
  if (input.statusFilter !== 'all' && input.tab !== 'active') {
    result = result.filter((run) => run.status === input.statusFilter);
  }
  if (input.flowFilter) {
    result = result.filter((run) => run.flowType === input.flowFilter);
  }
  if (input.laneFilter) {
    result = result.filter((run) => run.lane === input.laneFilter);
  }
  if (input.familyFilter) {
    result = result.filter((run) => run.familyId === input.familyFilter);
  }
  const tag = input.tagFilter.trim().toLowerCase();
  if (tag) {
    result = result.filter((run) => run.tags?.some((candidate) => candidate === tag));
  }
  const query = input.searchQuery.trim().toLowerCase();
  if (query) {
    result = result.filter(
      (run) =>
        run.ticketOrPr.toLowerCase().includes(query) ||
        Boolean(run.summary?.toLowerCase().includes(query)) ||
        Boolean(dispositionLabel(run.metrics.disposition).includes(query)) ||
        Boolean(run.tags?.some((tag) => tag.includes(query))),
    );
  }
  switch (input.sortBy) {
    case 'oldest':
      return [...result].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'duration':
      return [...result].sort((a, b) => (b.metrics.durationMs ?? 0) - (a.metrics.durationMs ?? 0));
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
