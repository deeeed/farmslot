import { type Run, runOutputCloseUnavailableReason } from '@farmslot/protocol';

import { readSlotField } from '../core/index.js';
import { publishCompletedRun, releaseCompletedRunSlot } from '../methods/run/lifecycle-control.js';
import { bumpRunGeneration, cancelRunEngine } from '../run-engine/orchestrator.js';
import {
  beginTerminalTeardown,
  endTerminalTeardown,
} from '../run-engine/terminal-teardown-registry.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { verifyRunOutputReview } from './output.js';

export interface OutputCloseDependencies {
  publish(run: Run): Promise<Run>;
  releaseSlot(run: Run): Promise<{ released: boolean }>;
  slotOwner(slotId: string): Promise<unknown>;
}

const pendingCloses = new Map<string, Promise<Run>>();

/** Close execution, not the proof verdict. Resource teardown uses the same
 * ownership-checked release as other operator terminal actions. */
export async function closeRunOutput(
  runId: string,
  decisionId: string,
  deps: OutputCloseDependencies = {
    publish: publishCompletedRun,
    releaseSlot: releaseCompletedRunSlot,
    slotOwner: (slotId) => readSlotField(slotId, 'current_run_id'),
  },
): Promise<Run> {
  const key = `${runId}:${decisionId}`;
  const pending = pendingCloses.get(key);
  if (pending) return pending;
  const operation = closeRunOutputOnce(runId, decisionId, deps);
  pendingCloses.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pendingCloses.get(key) === operation) pendingCloses.delete(key);
  }
}

async function closeRunOutputOnce(
  runId: string,
  decisionId: string,
  deps: OutputCloseDependencies,
): Promise<Run> {
  let heldSlot: string | null = null;
  try {
    const run = await withRunTransition(runId, async () => {
      const existing = getRun(runId);
      if (existing?.output?.closedAt) {
        const decision = existing.decisions.find((entry) => entry.id === decisionId);
        if (
          existing.status !== 'done' ||
          decision?.resolvedAction !== 'close-run' ||
          !decision.resolvedAt
        )
          throw new Error('Execution was not closed by this decision');
        if (!existing.output.closeError && !existing.output.cleanupPending) return existing;
        // Cleanup retries do not review new report bytes or publish completion
        // again. Lost/changed artifacts must not strand already-closed resources.
        heldSlot = existing.slotId;
        if (heldSlot) beginTerminalTeardown(heldSlot);
        const retry = updateRun(runId, {
          output: { ...existing.output, closeError: undefined, cleanupPending: Boolean(heldSlot) },
        });
        await persistRunNow(retry, 'retrying closed output cleanup');
        return retry;
      }
      const verified = await verifyRunOutputReview(runId, decisionId, true);
      const refusal = runOutputCloseUnavailableReason(verified);
      if (refusal) throw new Error(refusal);
      heldSlot = verified.slotId;
      if (heldSlot) beginTerminalTeardown(heldSlot);
      cancelRunEngine(runId);
      bumpRunGeneration(runId);
      const current = getRun(runId)!;
      const closedAt = current.output?.closedAt ?? new Date().toISOString();
      const closed = updateRun(runId, {
        status: 'done',
        completedAt: current.completedAt ?? closedAt,
        output: {
          ...current.output!,
          closedAt,
          closeError: undefined,
          cleanupPending: Boolean(heldSlot),
        },
        // Keep the original error, step history and metrics, including PARTIAL.
        decisions: current.decisions.map((decision) =>
          decision.id === decisionId
            ? {
                ...decision,
                resolvedAt: decision.resolvedAt ?? closedAt,
                resolvedAction: 'close-run',
              }
            : decision,
        ),
        recoveryProposal: { status: 'idle', generation: current.engineState?.generation ?? 0 },
        backlogReconcilePending: Boolean(current.backlogItemId) || undefined,
        analyticsEmittedAt: current.output?.closedAt ? current.analyticsEmittedAt : undefined,
      });
      await persistRunNow(closed, 'operator closed execution with recorded outcome');
      return deps.publish(closed);
    });
    // Release outside machine/run locks: native handoffs may need those locks.
    // A persisted error makes failed cleanup visible and allows an explicit retry.
    if (!heldSlot) return run;
    try {
      const result = await deps.releaseSlot(run);
      if (!result.released && (await deps.slotOwner(heldSlot)) === runId) {
        throw new Error(
          'Slot release was refused while this run still owns the slot. Retry resource cleanup.',
        );
      }
    } catch (error) {
      const current = getRun(runId)!;
      const failed = updateRun(runId, {
        output: {
          ...current.output!,
          cleanupPending: true,
          closeError: error instanceof Error ? error.message : String(error),
        },
      });
      await persistRunNow(failed, 'closed output cleanup failed');
      return failed;
    }
    const current = getRun(runId)!;
    const released = updateRun(runId, { output: { ...current.output!, cleanupPending: false } });
    await persistRunNow(released, 'closed output cleanup complete');
    return released;
  } finally {
    if (heldSlot) endTerminalTeardown(heldSlot);
  }
}
