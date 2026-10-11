import { AsyncLocalStorage } from 'node:async_hooks';

import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { readSlotField } from '../core/index.js';
import { getRun } from '../runs/store.js';

interface ReviewOperation {
  runId: string;
  slotId: string | null | undefined;
  taskFile: Run['taskFile'];
  owner: string | undefined;
  generation: number;
  mutation?: { active: boolean };
}

const operations = new AsyncLocalStorage<ReviewOperation>();
const mutationTails = new Map<string, Promise<void>>();

export function nativeReviewOperationIsCurrent(): boolean {
  return operationIsCurrent(operations.getStore());
}

function operationIsCurrent(operation: ReviewOperation | undefined): boolean {
  if (!operation) return true;
  const run = getRun(operation.runId);
  return Boolean(
    run &&
    run.transport === 'native' &&
    !isTerminalRunStatus(run.status) &&
    run.status !== 'paused' &&
    run.slotId === operation.slotId &&
    run.taskFile === operation.taskFile &&
    run.nativeOwnerPrincipalId === operation.owner &&
    (run.engineState?.generation ?? 0) === operation.generation,
  );
}

/** Remote watcher callbacks run outside their creator's async context. */
export function captureNativeReviewOperationCheck(): () => boolean {
  const operation = operations.getStore();
  return () => operationIsCurrent(operation);
}

export function assertNativeReviewOperationCurrent(): void {
  if (!nativeReviewOperationIsCurrent())
    throw new Error('Native review operation was superseded by another run action');
}

export function withNativeReviewOperation<T>(run: Run, operation: () => Promise<T>): Promise<T> {
  if (run.transport !== 'native') return operation();
  const existing = operations.getStore();
  if (existing) {
    if (existing.runId !== run.id) throw new Error('Native review operation changed runs');
    assertNativeReviewOperationCurrent();
    return operation();
  }
  return operations.run(
    {
      runId: run.id,
      slotId: run.slotId,
      taskFile: run.taskFile,
      owner: run.nativeOwnerPrincipalId,
      generation: run.engineState?.generation ?? 0,
    },
    async () => {
      assertNativeReviewOperationCurrent();
      return operation();
    },
  );
}

/** Finish older file mutations before a successor prepares the same task directory. */
export async function withNativeReviewMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const operation = operations.getStore();
  if (!operation) return mutation();
  assertNativeReviewOperationCurrent();
  if (operation.mutation?.active) {
    const result = await mutation();
    assertNativeReviewOperationCurrent();
    return result;
  }
  const key = operation.slotId ? `slot:${operation.slotId}` : `run:${operation.runId}`;
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  mutationTails.set(key, tail);
  await previous;
  const token = { active: true };
  try {
    assertNativeReviewOperationCurrent();
    if (
      !operation.slotId ||
      (await readSlotField(operation.slotId, 'current_run_id')) !== operation.runId
    )
      throw new Error('Native review operation no longer owns its slot');
    assertNativeReviewOperationCurrent();
    const result = await operations.run({ ...operation, mutation: token }, mutation);
    assertNativeReviewOperationCurrent();
    return result;
  } finally {
    token.active = false;
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}
