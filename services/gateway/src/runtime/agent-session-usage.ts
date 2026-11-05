import type { Run, RunnerSessionUsage } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { contextSessionReceipt, upsertSessionUsage } from './agent-session-rows.js';
import { extractNativeAgentSessionUsage } from './native-session-usage.js';
import { extractRunnerSessionUsage, unavailableRunnerSessionUsage } from './session-usage.js';

export function recordRunSessionUsage(runId: string, receipt: RunnerSessionUsage): void {
  const run = getRun(runId);
  if (!run) return;
  const rows =
    receipt.requestId && receipt.identityKind === 'conversation'
      ? (run.sessionUsage ?? []).filter(
          (row) =>
            !(
              row.identityKind === 'request' &&
              row.runner === receipt.runner &&
              row.requestId === receipt.requestId
            ),
        )
      : (run.sessionUsage ?? []);
  updateRun(runId, { sessionUsage: upsertSessionUsage(rows, receipt) });
}

/** Completion's worker discovery can recover sessions whose old context was replaced. */
export function recordRecoveredWorkerUsage(
  run: Run,
  session: import('../runners/session-usage-provider.js').RecoveredUsageSession,
  usage: RunnerSessionUsage,
): void {
  const context = run.agentContexts?.find((item) => item.id === session.contextId);
  if (!context) return;
  const same = context.runnerSessionId === session.runnerSessionId;
  const row = contextSessionReceipt(
    run,
    {
      ...context,
      runnerSessionId: session.runnerSessionId,
      runnerSessionPath: session.runnerSessionPath,
      usage,
      ...(!same ? { startedAt: undefined, completedAt: undefined, nativeSession: undefined } : {}),
    },
    usage.measuredAt,
  );
  if (row) recordRunSessionUsage(run.id, row);
}

function completedMeasurement(
  row: RunnerSessionUsage,
  usage: RunnerSessionUsage,
): RunnerSessionUsage {
  const { error: _oldError, ...metadata } = row;
  const costUsd = usage.costUsd ?? null;
  const startedAt = row.startedAt ? Date.parse(row.startedAt) : NaN;
  const end = Date.parse(row.completedAt ?? usage.measuredAt);
  return {
    ...metadata,
    ...usage,
    costUsd,
    costStatus: costUsd === null ? 'unpriced' : 'estimated',
    costReason:
      costUsd === null
        ? (usage.costReason ?? 'Runner accounting has no verified price for this model')
        : undefined,
    durationMs:
      Number.isFinite(startedAt) && Number.isFinite(end)
        ? Math.max(0, end - startedAt)
        : (row.durationMs ?? null),
    captureGaps: [
      ...(usage.source === 'unavailable' ? [usage.error ?? 'Session usage unavailable'] : []),
      ...(!Number.isFinite(startedAt) ? ['Session start time is unavailable'] : []),
      ...(!usage.actualModel ? ['Actual model has not been reported'] : []),
      ...(row.effort == null ? ['Effective effort has not been reported'] : []),
    ],
  };
}

async function measure(run: Run, row: RunnerSessionUsage): Promise<RunnerSessionUsage> {
  try {
    const slotId = row.slotId ?? run.slotId ?? run.id;
    if (row.nativeSession) {
      return completedMeasurement(
        row,
        await extractNativeAgentSessionUsage({
          vars: { slotId, remoteRepo: '' },
          runner: row.runner ?? '',
          runnerSessionId: row.runnerSessionId ?? null,
          runnerSessionPath: row.runnerSessionPath,
          nativeSession: row.nativeSession,
        }),
      );
    }
    const vars = row.runnerSessionPath && row.slotId ? await loadSlotVars(row.slotId) : undefined;
    return completedMeasurement(
      row,
      await extractRunnerSessionUsage({
        slotId,
        vars,
        runner: row.runner,
        runnerSessionId: row.runnerSessionId,
        runnerSessionPath: row.runnerSessionPath,
      }),
    );
  } catch {
    return completedMeasurement(
      row,
      unavailableRunnerSessionUsage({
        runner: row.runner,
        runnerSessionId: row.runnerSessionId,
        error: 'Session source is unavailable on its recorded execution slot',
      }),
    );
  }
}

const pending = new Map<string, Promise<void>>();

/** Awaited at lifecycle settlement/cleanup. Stored source identity outlives its context. */
export function captureRunSessionUsage(runId: string): Promise<void> {
  const previous = pending.get(runId) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const run = getRun(runId);
      if (!run) return;
      for (const row of run.sessionUsage ?? []) {
        if (row.identityKind === 'request') continue;
        // A terminal receipt already measured after settlement needs no second read.
        if (
          row.source !== 'unavailable' &&
          !row.error &&
          row.completedAt &&
          row.measuredAt >= row.completedAt
        )
          continue;
        const measured = await measure(run, row);
        recordRunSessionUsage(runId, measured);
      }
      const latest = getRun(runId);
      if (latest) await persistRunNow(latest, 'agent session usage captured');
    })
    .catch(() => {
      console.warn('[agent-usage] Session capture could not be persisted');
    });
  pending.set(runId, operation);
  void operation
    .finally(() => {
      if (pending.get(runId) === operation) pending.delete(runId);
    })
    .catch(() => {});
  return operation;
}
