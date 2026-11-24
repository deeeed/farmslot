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
      bundleLock: { ...lock, waitMs: Math.round(lock.waitMs), heldMs: Math.round(lock.heldMs) },
      exec: Object.fromEntries(
        Object.entries(exec).map(([kind, { calls, seconds }]) => [
          kind,
          { calls, ms: Math.round(seconds * 1000) },
        ]),
      ),
    },
  };
}
