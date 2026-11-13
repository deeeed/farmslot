import { primaryRoleForFlow, type ReviewChainEntry, type Run } from '@farmslot/protocol';

import { sessionUsageKey } from '../runtime/agent-session-rows.js';
import {
  allRunSessionUsageReceipts,
  isHelperSession,
  sessionCosts,
  sessionUsageContributions,
} from '../runtime/session-usage-selection.js';

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
  const lastInventory = new Map<string, ReturnType<typeof allRunSessionUsageReceipts>[number]>();
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
    const inventory = allRunSessionUsageReceipts(record).filter(
      (row) => row.role === primaryRoleForFlow(record.flowType) && !isHelperSession(row),
    );
    const baselines = inventory.flatMap((row) => {
      const key = sessionUsageKey(row);
      const prior = key ? lastInventory.get(key) : undefined;
      return prior ? [prior] : [];
    });
    const cost =
      missingEarlier && entry.mode === 'warm'
        ? { costUsd: null, costReason: 'Earlier session usage unavailable' }
        : sessionCosts(rows, [...inventory, ...baselines]);
    for (const row of inventory) {
      const key = sessionUsageKey(row);
      if (key) lastInventory.set(key, row);
    }
    return {
      ...entry,
      durationMs: record.metrics.durationMs ?? null,
      ...cost,
    };
  });
}
