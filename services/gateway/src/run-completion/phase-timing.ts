import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import type { CompleteStepTiming } from '@farmslot/protocol';
import { type RunBundleLockTime, withRunBundleLockTime } from '@farmslot/run-bundle';

import { type ExecTally, withExecutionTally } from '../observability/performance.js';

const phases = new AsyncLocalStorage<Record<string, number>>();

/**
 * Adds `operation`'s wall time to the named phase of the COMPLETE step being measured.
 * Outside a measured step it only runs the operation. A phase named twice adds up.
 */
export async function timeCompletePhase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const record = phases.getStore();
  if (!record) return operation();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    record[name] = (record[name] ?? 0) + Math.round(performance.now() - start);
  }
}

/**
 * Runs a COMPLETE step and reports where its time went: named phases, the bundle-lock waits
 * and holds its captures caused, and the processes it started by kind (the shared exec
 * wrapper's tally). Phases can nest, so they need not add up to the total.
 */
export async function measureCompleteStep<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; timing: CompleteStepTiming }> {
  const record: Record<string, number> = {};
  const lock: RunBundleLockTime = { acquisitions: 0, waitMs: 0, heldMs: 0 };
  const exec: ExecTally = {};
  const start = performance.now();
  const value = await phases.run(record, () =>
    withRunBundleLockTime(lock, () => withExecutionTally(exec, operation)),
  );
  return {
    value,
    timing: {
      totalMs: Math.round(performance.now() - start),
      phasesMs: record,
      // A copy: an abandoned operation (a timed-out admission scan) can still write to `lock`.
      // Store operation times are summed unrounded and rounded once here.
      bundleLock: {
        ...structuredClone(lock),
        waitMs: Math.round(lock.waitMs),
        heldMs: Math.round(lock.heldMs),
        ...(lock.opsMs
          ? {
              opsMs: Object.fromEntries(
                Object.entries(lock.opsMs).map(([name, { count, ms }]) => [
                  name,
                  { count, ms: Math.round(ms) },
                ]),
              ),
            }
          : {}),
      },
      exec: Object.fromEntries(
        Object.entries(exec).map(([kind, { calls, seconds }]) => [
          kind,
          { calls, ms: Math.round(seconds * 1000) },
        ]),
      ),
    },
  };
}

/**
 * The same measurement for other lifecycle work (a finished run's slot release). A measurement
 * started inside another one keeps its own phases; its lock time and processes count in the
 * outer one's record.
 */
export const measurePhases = measureCompleteStep;
export const timePhase = timeCompletePhase;
