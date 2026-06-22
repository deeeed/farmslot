import {
  type AnalyticsBackfillResult,
  type AnalyticsQueryParams,
  type AnalyticsQueryResult,
  isTerminalRunStatus,
} from '@farmslot/protocol';

import {
  aggregateAnalytics,
  appendAnalyticsRecord,
  buildAnalyticsRecord,
  readAllAnalyticsRecords,
} from '../runs/analytics.js';
import { getAllRuns, updateRun } from '../runs/store.js';

/** Read-only aggregate over the analytics sink. */
export async function analyticsQuery(
  params: AnalyticsQueryParams = {},
): Promise<AnalyticsQueryResult> {
  const { records, parseFailures } = await readAllAnalyticsRecords();
  return aggregateAnalytics(records, params, new Date().toISOString(), parseFailures);
}

/**
 * One-time seed: write an analytics record for every terminal run currently in the store
 * that the sink doesn't already have. Idempotent — dedups against existing sink records and
 * the per-run analyticsEmittedAt flag, so re-running is safe. Forward-only fields (host load)
 * stay null for runs that predate the capture.
 */
export async function analyticsBackfill(): Promise<AnalyticsBackfillResult> {
  const { records } = await readAllAnalyticsRecords();
  const seen = new Set(records.map((r) => r.runId));
  let scanned = 0;
  let written = 0;
  let skipped = 0;
  for (const run of getAllRuns()) {
    if (!isTerminalRunStatus(run.status)) continue;
    scanned++;
    // Dedup on actual sink presence, not the analyticsEmittedAt flag: a run whose live emit set
    // the flag but failed to write (disk error) is absent from `seen`, so backfill recovers it.
    if (seen.has(run.id)) {
      skipped++;
      continue;
    }
    await appendAnalyticsRecord(buildAnalyticsRecord(run, { backfilled: true }));
    // Persist the idempotency flag so a later updateRun on this run won't append a duplicate
    // sink line. updateRun's emit hook is a no-op here (analyticsEmittedAt is now set). This is
    // one updateRun per seeded run — acceptable for a one-time operator command; query-time
    // dedup-by-runId is the safety net if a duplicate is ever written anyway.
    updateRun(run.id, { analyticsEmittedAt: run.completedAt ?? run.updatedAt });
    seen.add(run.id);
    written++;
  }
  return { scanned, written, skipped };
}
