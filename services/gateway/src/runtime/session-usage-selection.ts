import { primaryRoleForFlow, type Run, type RunnerSessionUsage } from '@farmslot/protocol';

import {
  registerContextSessionUsage,
  sessionUsageKey,
  upsertSessionUsage,
} from './agent-session-rows.js';
import { preferSessionUsage } from './reviewer-usage.js';

export const isReviewSession = (row: RunnerSessionUsage): boolean => row.role === 'review';
export const isHelperSession = (row: RunnerSessionUsage): boolean =>
  row.kind === 'helper' ||
  row.identityKind === 'request' ||
  row.runner?.startsWith('api:') === true;

/** Canonical receipts first; old result/metric-only records remain readable. */
export function allRunSessionUsageReceipts(run: Run): RunnerSessionUsage[] {
  let rows = registerContextSessionUsage(run, run.updatedAt) ?? [];
  for (const review of run.engineState?.publishGate?.reviews ?? []) {
    if (!review.usage) continue;
    const usage = review.usage;
    const receipt: RunnerSessionUsage = {
      ...usage,
      costUsd: usage.costUsd ?? null,
      costStatus: usage.costStatus,
      costReason: usage.costReason,
      runner: usage.runner ?? review.runner,
      runnerSessionId: usage.runnerSessionId ?? review.reviewerSessionId,
      model: review.model ?? usage.model ?? null,
      role: 'review',
      runId: run.id,
      flowType: run.flowType,
    };
    rows = sessionUsageKey(receipt) ? upsertSessionUsage(rows, receipt) : [...rows, receipt];
  }

  if (
    !rows.some(
      (row) =>
        (!isReviewSession(row) ||
          (row.role === primaryRoleForFlow(run.flowType) &&
            row.runnerSessionId === run.metrics.runnerSessionId)) &&
        !isHelperSession(row) &&
        row.source !== 'unavailable' &&
        row.totalTokens != null,
    )
  ) {
    const m = run.metrics;
    const split = [
      m.sessionInputTokens,
      m.sessionOutputTokens,
      m.sessionCacheRead,
      m.sessionCacheCreation,
    ];
    const legacyTotal =
      m.sessionTotalTokens != null && m.sessionTotalTokens > 0
        ? m.sessionTotalTokens
        : split.reduce<number>(
            (sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
            0,
          );
    if (
      m.sessionTotalTokens != null ||
      m.sessionTurns != null ||
      split.some((value) => value != null)
    ) {
      const legacy: RunnerSessionUsage = {
        runner: m.runner,
        model: m.model,
        actualModel: m.actualModel,
        runnerSessionId:
          m.sessionUsageScope === 'review-generation-delta' ? null : m.runnerSessionId,
        runnerSessionPath: m.runnerSessionPath,
        role: primaryRoleForFlow(run.flowType),
        runId: run.id,
        flowType: run.flowType,
        source: 'runner-transcript',
        measuredAt: run.updatedAt,
        turns: m.sessionTurns,
        inputTokens: m.sessionInputTokens,
        outputTokens: m.sessionOutputTokens,
        cacheRead: m.sessionCacheRead,
        cacheCreation: m.sessionCacheCreation,
        totalTokens: legacyTotal,
        costUsd: m.costEstimate,
        costStatus: m.costEstimate == null ? 'unpriced' : 'estimated',
        ...(m.costEstimate == null ? { costReason: 'Legacy worker cost is unavailable' } : {}),
      };
      rows = sessionUsageKey(legacy) ? upsertSessionUsage(rows, legacy) : [...rows, legacy];
    }
  }
  return rows.map<RunnerSessionUsage>((row) => {
    const priced =
      row.source !== 'unavailable' &&
      row.costStatus !== 'unpriced' &&
      typeof row.costUsd === 'number' &&
      Number.isFinite(row.costUsd) &&
      row.costUsd >= 0;
    return {
      ...row,
      costUsd: priced ? row.costUsd : null,
      costStatus: priced ? 'estimated' : 'unpriced',
      costReason: priced
        ? undefined
        : (row.costReason ?? row.error ?? 'No verified price for this historical session'),
    };
  });
}

/** Totals consume verified rows; UI inventories consume the unfiltered shared projection. */
export function runSessionUsageReceipts(run: Run): RunnerSessionUsage[] {
  return allRunSessionUsageReceipts(run).filter(
    (row) => row.source !== 'unavailable' && !row.error && row.totalTokens != null,
  );
}

/** Attribute only a conversation's growth to a later run; never sum warm snapshots. */
export function sessionUsageContributions(runs: readonly Run[]): Map<string, RunnerSessionUsage[]> {
  const seen = new Map<string, RunnerSessionUsage>();
  const result = new Map<string, RunnerSessionUsage[]>();
  const counters = [
    'inputTokens',
    'outputTokens',
    'cacheRead',
    'cacheCreation',
    'totalTokens',
    'turns',
    'costUsd',
  ] as const;
  for (const run of [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    const contributions: RunnerSessionUsage[] = [];
    for (const row of runSessionUsageReceipts(run)) {
      const key = sessionUsageKey(row);
      const previous = key ? seen.get(key) : undefined;
      if (previous && preferSessionUsage(previous, row) === previous) continue;
      if (key) seen.set(key, row);
      const contribution = { ...row };
      if (previous)
        for (const field of counters) {
          const value = row[field];
          const before = previous[field];
          contribution[field] =
            typeof value === 'number' && typeof before === 'number'
              ? Math.max(0, value - before)
              : value;
        }
      contributions.push(contribution);
    }
    result.set(run.id, contributions);
  }
  return result;
}
