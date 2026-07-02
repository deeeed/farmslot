/**
 * Pure helpers for the dispatch wizard's in-wizard comparison entry. Extracted so
 * the variant-collision and prior-runs grouping logic stays unit-testable without
 * standing up a DOM environment for the wizard component.
 */
import {
  buildComparisonVariant,
  nextFreeComparisonVariant,
  resolveRunSlotId,
  type Run,
} from '@farmslot/protocol';

import { resolveRunEngine } from '../runs/run-utils.js';

/** Group prior runs by familyId; root runs without a familyId fall back to their own id
 *  so the banner still shows them under a stable bucket. Each group is sorted newest-first. */
export function groupPriorRunsByFamily(runs: ReadonlyArray<Run>): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = r.familyId || r.id;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return groups;
}

/** Filter runs to those whose ticketOrPr exactly matches the operator-typed input or its
 *  server-normalized form. `run.list({ search })` is a substring match against ticketOrPr
 *  OR summary, so the banner narrows post-response to avoid surfacing unrelated families
 *  whose summary happens to mention the typed key. */
export function filterRunsByExactTicket(
  runs: ReadonlyArray<Run>,
  ticket: string,
  normalizedTicket: string,
): Run[] {
  const candidate = ticket.trim();
  if (!candidate) return [];
  return runs.filter(
    (r) => r.ticketOrPr === candidate || (!!normalizedTicket && r.ticketOrPr === normalizedTicket),
  );
}

/** Newest-first ordering for the comparison-flow run picker. */
export function sortRunsNewestFirst(runs: ReadonlyArray<Run>): Run[] {
  return [...runs].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

/** Restrict comparison picker rows to active global project/machine filters when set. */
export function filterRunsForComparisonPicker(
  runs: ReadonlyArray<Run>,
  filters: {
    projectFilters: readonly string[];
    machineFilters: readonly string[];
  },
): Run[] {
  let result = sortRunsNewestFirst(runs);
  if (filters.projectFilters.length > 0) {
    result = result.filter((run) => filters.projectFilters.includes(run.project));
  }
  if (filters.machineFilters.length > 0) {
    result = result.filter((run) => {
      const slotId = resolveRunSlotId(run);
      if (!slotId) return false;
      return filters.machineFilters.some(
        (machine) => slotId === machine || slotId.startsWith(`${machine}-`),
      );
    });
  }
  return result;
}

export function compareRunSearchText(run: Run): string {
  const slotId = resolveRunSlotId(run);
  const engine = resolveRunEngine(run);
  return [
    run.id,
    run.familyId,
    run.parentRunId,
    run.ticketOrPr,
    run.project,
    run.flowType,
    run.status,
    run.lane,
    run.variant,
    slotId,
    engine.runner,
    engine.model,
    run.summary,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function familyKeyForRun(run: Pick<Run, 'familyId' | 'id'>): string {
  return run.familyId || run.id;
}

/** Runs in the same family as `run`, oldest-first for lane timeline display. */
export function familyRunsForComparePicker(run: Run, runs: ReadonlyArray<Run>): Run[] {
  const key = familyKeyForRun(run);
  return runs
    .filter((candidate) => familyKeyForRun(candidate) === key)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export interface ComparePickerFamilyLaneSummary {
  familyId: string;
  totalRuns: number;
  productionCount: number;
  comparisonCount: number;
  activeCount: number;
  /** True when the family already has at least one comparison-lane sibling. */
  hasComparisonLane: boolean;
  headline: string;
  forkHint: string;
}

export function summarizeComparePickerFamilyLane(
  run: Run,
  familyRuns: ReadonlyArray<Run>,
): ComparePickerFamilyLaneSummary {
  const familyId = familyKeyForRun(run);
  const productionCount = familyRuns.filter((member) => member.lane !== 'comparison').length;
  const comparisonCount = familyRuns.filter((member) => member.lane === 'comparison').length;
  const activeCount = familyRuns.filter(
    (member) => !['done', 'failed', 'cancelled'].includes(member.status),
  ).length;
  const hasComparisonLane = comparisonCount > 0;
  const siblingLabel =
    familyRuns.length === 1
      ? 'production root only'
      : `${familyRuns.length} runs · ${comparisonCount} comparison sibling${comparisonCount === 1 ? '' : 's'}`;
  const headline = `Family ${familyId.slice(0, 8)} · ${siblingLabel}`;
  const forkHint = hasComparisonLane
    ? 'Your fork joins this comparison family on a new variant lane.'
    : familyRuns.length === 1
      ? 'Your fork adds the first comparison sibling to this family.'
      : 'Your fork adds another comparison sibling alongside existing production work.';
  return {
    familyId,
    totalRuns: familyRuns.length,
    productionCount,
    comparisonCount,
    activeCount,
    hasComparisonLane,
    headline,
    forkHint,
  };
}

export function comparePickerFamilyChipLabel(run: Run): string {
  if (run.lane === 'comparison') return run.variant?.trim() || 'comparison';
  return 'production';
}

export interface VariantCollisionState {
  collides: boolean;
  /** Suggested next-free variant when a collision exists; empty string otherwise. */
  suggested: string;
}

/** Determine whether the default `<runner>-<safe(model)>` variant tag would collide with
 *  an existing sibling in the family. When it does, returns a suggested next-free suffix
 *  the wizard can pre-fill into the variant input. */
export function detectVariantCollision(
  familyRuns: ReadonlyArray<Run>,
  runner: string | null | undefined,
  model: string | null | undefined,
): VariantCollisionState {
  const base = buildComparisonVariant(runner, model);
  if (!base) return { collides: false, suggested: '' };
  const taken = new Set(familyRuns.map((r) => r.variant ?? '').filter(Boolean));
  if (!taken.has(base)) return { collides: false, suggested: '' };
  return {
    collides: true,
    suggested: nextFreeComparisonVariant(familyRuns, runner, model),
  };
}

/** Return true when a comparison-mode dispatch should be blocked because the operator-supplied
 *  variant input is empty or duplicates an existing sibling within the family. */
export function isVariantInputBlocked(
  familyRuns: ReadonlyArray<Run>,
  variantInput: string,
  collides: boolean,
): boolean {
  if (!collides) return false;
  const value = variantInput.trim();
  if (!value) return true;
  return familyRuns.some((r) => (r.variant ?? '') === value);
}
