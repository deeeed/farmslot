import type {
  FamilyUsageContribution,
  FamilyUsageInterval,
  FamilyUsageReviewRound,
  RunnerSessionUsage,
} from '@farmslot/protocol';

export interface UsageTotals {
  tokens: number | null;
  /** Known subtotal. `unpriced` prevents treating it as a complete estimate. */
  cost: number | null;
  measured: number;
  missing: number;
  unpriced: number;
}

export interface UsageAttributionPoint {
  index: number;
  tokens: number | null;
  cost: number | null;
  unpriced: number;
  runIds: string[];
}

export interface UsageBreakdown extends UsageTotals {
  label: string;
}

export interface ReviewRoundUsageTotals {
  tokens: number | null;
  reviewCost: number | null;
  addedCost: number | null;
}

export function roundUsageTotals(round: FamilyUsageReviewRound): ReviewRoundUsageTotals {
  const usage = round.costScope === 'unavailable' ? undefined : round.usage;
  const reviewCost = usage && priced(usage) ? (usage.costUsd ?? null) : null;
  return {
    tokens: usage && measured(usage) ? (usage.totalTokens ?? null) : null,
    reviewCost,
    addedCost: null,
  };
}

function measured(row: RunnerSessionUsage): boolean {
  return row.source !== 'unavailable' && !row.error && row.totalTokens != null;
}

function priced(row: RunnerSessionUsage): boolean {
  return (
    row.source !== 'unavailable' &&
    !row.error &&
    row.costStatus !== 'unpriced' &&
    row.costUsd != null
  );
}

export function summarizeUsage(rows: readonly RunnerSessionUsage[]): UsageTotals {
  const captured = rows.filter(measured);
  const costRows = rows.filter(priced);
  return {
    tokens: captured.length ? captured.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0) : null,
    cost: costRows.length ? costRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) : null,
    measured: captured.length,
    missing: rows.length - captured.length,
    unpriced: captured.filter((row) => !priced(row)).length,
  };
}

/** Canonical run attribution is accounting, not an observation history. */
export function buildUsageAttribution(
  rows: readonly FamilyUsageContribution[],
): UsageAttributionPoint[] {
  const groups = new Map<string, RunnerSessionUsage[]>();
  for (const row of rows) {
    const group = groups.get(row.runId) ?? [];
    group.push(row.usage);
    groups.set(row.runId, group);
  }
  const points: UsageAttributionPoint[] = [];
  let tokens: number | null = null;
  let cost: number | null = null;
  let unpriced = 0;
  for (const [runId, group] of groups) {
    const totals = summarizeUsage(group);
    if (totals.tokens === null && totals.cost === null) continue;
    if (totals.tokens !== null) tokens = (tokens ?? 0) + totals.tokens;
    if (totals.cost !== null) cost = (cost ?? 0) + totals.cost;
    unpriced += totals.unpriced;
    points.push({ index: points.length, tokens, cost, unpriced, runIds: [runId] });
  }
  return points;
}

export function usageAccountingState(
  rows: readonly FamilyUsageContribution[],
  receipts: number,
): 'captured' | 'no-attributed-measurement' | 'not-captured' {
  if (rows.some((row) => measured(row.usage) || priced(row.usage))) return 'captured';
  return receipts > 0 ? 'no-attributed-measurement' : 'not-captured';
}

export function usageBreakdown(
  rows: readonly RunnerSessionUsage[],
  dimension: 'model' | 'runner',
  inventory: readonly RunnerSessionUsage[] = rows,
): UsageBreakdown[] {
  const labelFor = (row: RunnerSessionUsage) =>
    (dimension === 'model' ? row.actualModel : row.runner) ?? 'Not reported';
  const labels = new Set([...rows, ...inventory].map(labelFor));
  return [...labels]
    .map((label) => {
      const totals = summarizeUsage(rows.filter((row) => labelFor(row) === label));
      const coverage = summarizeUsage(inventory.filter((row) => labelFor(row) === label));
      return { ...totals, label, missing: coverage.missing, unpriced: coverage.unpriced };
    })
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.label.localeCompare(b.label));
}

/** Completed interval union. Parallel reviewers and shared fixes add wall time once. */
export interface UsageIntervalSummary {
  durationMs: number | null;
  incomplete: number;
}

export function usageIntervalSummary(
  intervals: readonly FamilyUsageInterval[],
): UsageIntervalSummary {
  const ranges: Array<[number, number]> = [];
  let incomplete = 0;
  for (const interval of intervals) {
    const start = Date.parse(interval.startedAt ?? '');
    const end = Date.parse(interval.completedAt ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      incomplete += 1;
      continue;
    }
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let duration = 0;
  let end = -Infinity;
  for (const [start, stop] of ranges) {
    duration += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return { durationMs: ranges.length ? duration : null, incomplete };
}

export function usageIntervalDuration(intervals: readonly FamilyUsageInterval[]): number | null {
  return usageIntervalSummary(intervals).durationMs;
}
