import {
  type HumanGrade,
  isActiveListRun,
  normalizeRunTags,
  type Run,
  type RunMetrics,
} from '../contracts/runs.js';
import type { RunListParams } from '../rpc/run.js';

import { runLinkedTicketRefs } from './linked-tickets.js';
import { resolveRunSlotId } from './slot-resolution.js';

/** The run fields `run.list` filters, search and sorting read, on a full run or a projection. */
export type RunListFields = Pick<
  Run,
  'status' | 'flowType' | 'project' | 'ticketOrPr' | 'createdAt'
> &
  Partial<
    Pick<Run, 'archivedAt' | 'prNumber' | 'familyId' | 'lane' | 'variant' | 'summary' | 'tags'>
  > & {
    metrics: Pick<RunMetrics, 'outcome' | 'durationMs'>;
    humanGrade?: Pick<HumanGrade, 'recipe_semantic'>;
  };

/** What a run list keeps for every live run, with or without its row: filters, search, sorting, totals. */
export type RunListProjection = RunListFields &
  Pick<Run, 'id' | 'updatedAt'> & {
    projected: true;
    metrics: Pick<RunMetrics, 'outcome' | 'durationMs' | 'disposition'>;
    /** `resolveRunSlotId` of the run. */
    slotId: string | null;
    /** `runLinkedTicketRefs` of the run. */
    linkedTicketRefs: string[];
  };

/** The `run.list` parameters that choose and order rows. */
export type RunListFilter = Pick<
  RunListParams,
  | 'status'
  | 'active'
  | 'limit'
  | 'flowType'
  | 'project'
  | 'prNumber'
  | 'familyId'
  | 'lane'
  | 'variant'
  | 'outcome'
  | 'dateFrom'
  | 'dateTo'
  | 'search'
  | 'tags'
  | 'sort'
>;

export function runListProjection(run: Run): RunListProjection {
  return {
    projected: true,
    id: run.id,
    status: run.status,
    archivedAt: run.archivedAt,
    flowType: run.flowType,
    project: run.project,
    prNumber: run.prNumber,
    familyId: run.familyId,
    lane: run.lane,
    variant: run.variant,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ticketOrPr: run.ticketOrPr,
    summary: run.summary,
    tags: run.tags,
    metrics: {
      outcome: run.metrics.outcome,
      durationMs: run.metrics.durationMs,
      disposition: run.metrics.disposition,
    },
    ...(run.humanGrade ? { humanGrade: { recipe_semantic: run.humanGrade.recipe_semantic } } : {}),
    slotId: resolveRunSlotId(run),
    linkedTicketRefs: runLinkedTicketRefs(run),
  };
}

/** The gateway's `run.list` filters, search included. Its `listRuns` and the client cache share it. */
export function matchesRunList(filter: RunListFilter): (run: RunListFields) => boolean {
  const search = filter.search?.toLowerCase();
  const tags = normalizeRunTags(filter.tags);
  return (run) => {
    if (filter.status) {
      if (run.status !== filter.status) return false;
    } else if (filter.active && !isActiveListRun(run)) return false;
    if (filter.flowType && run.flowType !== filter.flowType) return false;
    if (filter.project && run.project !== filter.project) return false;
    if (filter.prNumber != null && run.prNumber !== filter.prNumber) return false;
    if (filter.familyId && run.familyId !== filter.familyId) return false;
    if (filter.lane && run.lane !== filter.lane) return false;
    if (filter.variant !== undefined && (run.variant ?? null) !== (filter.variant ?? null))
      return false;
    if (filter.outcome && run.metrics.outcome !== filter.outcome) return false;
    if (filter.dateFrom && !(run.createdAt >= filter.dateFrom)) return false;
    if (filter.dateTo && !(run.createdAt <= filter.dateTo)) return false;
    // Tags are matched as stored, not lowercased, as the gateway always has.
    if (
      search &&
      !run.ticketOrPr.toLowerCase().includes(search) &&
      !run.summary?.toLowerCase().includes(search) &&
      !run.tags?.some((tag) => tag.includes(search))
    )
      return false;
    if (tags.length > 0) {
      const own = new Set(normalizeRunTags(run.tags));
      if (!tags.every((tag) => own.has(tag))) return false;
    }
    return true;
  };
}

const GRADE_ORDER: Record<string, number> = { good: 3, ok: 2, bad: 1 };

/** A stable sort, so equal keys keep the input order: the gateway's live-map order. */
export function sortRunList<R extends RunListFields>(
  runs: readonly R[],
  sort: RunListFilter['sort'] = 'newest',
): R[] {
  const result = [...runs];
  switch (sort) {
    case 'oldest':
      return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'duration':
      return result.sort((a, b) => (b.metrics.durationMs ?? 0) - (a.metrics.durationMs ?? 0));
    case 'grade':
      return result.sort(
        (a, b) =>
          (GRADE_ORDER[b.humanGrade?.recipe_semantic ?? ''] ?? 0) -
          (GRADE_ORDER[a.humanGrade?.recipe_semantic ?? ''] ?? 0),
      );
    default:
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** Active, family, PR and tag lists are complete by default; only the open-ended list pages. */
export function runListLimit(filter: RunListFilter, matched: number): number {
  return (
    filter.limit ??
    (filter.active ||
    filter.familyId ||
    filter.prNumber != null ||
    normalizeRunTags(filter.tags).length > 0
      ? matched
      : 500)
  );
}

/** One `run.list` page: matching rows, sorted and limited, and the count before the limit. */
export function runListPage<R extends RunListFields>(
  runs: readonly R[],
  filter: RunListFilter,
): { runs: R[]; totalCount: number } {
  const matched = runs.filter(matchesRunList(filter));
  return {
    runs: sortRunList(matched, filter.sort).slice(0, runListLimit(filter, matched.length)),
    totalCount: matched.length,
  };
}
