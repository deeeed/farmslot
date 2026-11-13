import { primaryRoleForFlow, type ReviewChainEntry, type Run } from '@farmslot/protocol';

import { isHelperSession, sessionUsageContributions } from '../runtime/session-usage-selection.js';

/** Carry accounting facts; warm conversation subtraction stays in the existing usage owner. */
export function reviewChainWithMetrics(
  chain: ReviewChainEntry[],
  records: readonly Run[],
): ReviewChainEntry[] {
  const byId = new Map(records.map((run) => [run.id, run]));
  const chainRuns = chain.flatMap((entry) => {
    const record = byId.get(entry.runId);
    return record ? [record] : [];
  });
  const contributions = sessionUsageContributions(chainRuns);
  let missingEarlier = false;
  return chain.map((entry) => {
    const record = byId.get(entry.runId);
    if (!record) {
      missingEarlier = true;
      return entry;
    }
    const rows = (contributions.get(record.id) ?? []).filter(
      (row) => row.role === primaryRoleForFlow(record.flowType) && !isHelperSession(row),
    );
    const priced =
      rows.length > 0 && rows.every((row) => row.costUsd != null && row.costStatus !== 'unpriced');
    const unavailableBaseline = missingEarlier && entry.mode === 'warm';
    const costUsd =
      priced && !unavailableBaseline
        ? rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
        : null;
    return {
      ...entry,
      durationMs: record.metrics.durationMs ?? null,
      costUsd,
      ...(costUsd === null
        ? {
            costReason: unavailableBaseline
              ? 'Earlier session usage unavailable'
              : 'Cost not recorded',
          }
        : { costReason: undefined }),
    };
  });
}
