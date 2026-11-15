// Operation records are optional task artifacts emitted by command runtimes.
import path from 'node:path';

import {
  type TaskOperation,
  type TaskProgressStructured,
  validateOperationRecord,
} from '@farmslot/protocol';

import { slotListFiles, type SlotLocality, slotReadFile } from '../core/slot-io.js';

type CachedOperation = { size?: number; mtimeMs: number; operation: TaskOperation };

/** Parsed records per operations directory, so a poll reads only new or changed files. */
const operationCache = new Map<string, Map<string, CachedOperation>>();
const OPERATION_CACHE_DIRECTORIES = 64;

function cachedDirectory(ctx: SlotLocality, directory: string): Map<string, CachedOperation> {
  const key = `${ctx.machine}\0${ctx.host}\0${directory}`;
  const known = operationCache.get(key) ?? new Map<string, CachedOperation>();
  // Re-inserting keeps the most recently read directories when the cap evicts.
  operationCache.delete(key);
  operationCache.set(key, known);
  if (operationCache.size > OPERATION_CACHE_DIRECTORIES)
    operationCache.delete(operationCache.keys().next().value as string);
  return known;
}

async function readOperation(
  ctx: SlotLocality,
  directory: string,
  name: string,
): Promise<TaskOperation> {
  const value = JSON.parse(await slotReadFile(ctx, path.join(directory, name))) as TaskOperation;
  validateOperationRecord(value, name.slice(0, -5));
  // Links always address this record's task-local log, never an arbitrary supplied path.
  return { ...value, logPath: `artifacts/operations/${value.id}.log` };
}

export async function attachOperations(
  ctx: SlotLocality,
  checklist: string,
  progress: TaskProgressStructured,
): Promise<void> {
  const taskDir = path.dirname(checklist);
  const directory = path.join(taskDir, 'artifacts', 'operations');
  try {
    const files = await slotListFiles(ctx, directory);
    if (!files) return;
    const records = files.filter((file) => /^[a-f0-9-]{36}\.json$/.test(file.name));
    const cache = cachedDirectory(ctx, directory);
    const operations = await Promise.all(
      records.map(async (file) => {
        const known = cache.get(file.name);
        // A record is rewritten while its operation runs; size and mtime tell an unchanged one.
        if (
          known &&
          file.mtimeMs !== undefined &&
          known.mtimeMs === file.mtimeMs &&
          known.size === file.size
        )
          return known.operation;
        const operation = await readOperation(ctx, directory, file.name);
        if (file.mtimeMs !== undefined)
          cache.set(file.name, { size: file.size, mtimeMs: file.mtimeMs, operation });
        return operation;
      }),
    );
    for (const name of cache.keys())
      if (!records.some((file) => file.name === name)) cache.delete(name);
    progress.operations = operations.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  } catch (error) {
    progress.operationsError = `Operation progress unavailable: ${(error as Error).message}`;
  }
}
