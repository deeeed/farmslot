import type { Run, RunActivityRecord } from '@farmslot/protocol';

import { parseChecklistTiming } from '../tasks/checklist-timing.js';

/** Pure shared selection: recapture never observes a later worker or its mutable task files. */
export function activityForRun(run: Run): RunActivityRecord {
  if (run.metrics?.activity) return run.metrics.activity;
  const reason = 'Original-worker process sources were not frozen before the terminal outcome';
  const unavailable = { status: 'unavailable' as const, reason };
  const unknown = { value: null, reason, references: [] };
  const capturedAt = run.completedAt ?? run.createdAt;
  const legacyTiming = parseChecklistTiming(run.metrics?.checklistTiming);
  return {
    schemaVersion: 1,
    process: {
      schemaVersion: 1,
      capturedAt,
      attempt: {
        runId: run.id,
        contextId: null,
        attemptId: null,
        role: null,
        engineGeneration: null,
        startedAt: null,
        frozenAt: capturedAt,
        executionNodeId: null,
      },
      sources: legacyTiming
        ? [
            {
              id: 'run-metrics',
              kind: 'run-metrics',
              contextId: null,
              executionNodeId: null,
              clockId: null,
              path: 'metrics.checklistTiming',
            },
          ]
        : [],
      checklist: {
        events: legacyTiming?.events ?? null,
        expectedSteps: null,
        complete: null,
        source: legacyTiming ? { sourceId: 'run-metrics' } : null,
      },
      commits: null,
      firstProductEdit: null,
      firstBaselineRun: null,
      rootCause: { present: null, source: null },
      markCalls: null,
      coverage: {
        checklist: legacyTiming
          ? { status: 'partial', reason: 'LEGACY_TIMING_WITHOUT_FROZEN_ATTEMPT' }
          : unavailable,
        commits: unavailable,
        productEdits: unavailable,
        baseline: unavailable,
        rootCause: unavailable,
        markCalls: unavailable,
      },
      labels: { skipped_checklist: unknown, fix_before_baseline: unknown },
    },
  };
}
