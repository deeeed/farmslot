// Operation records are optional task artifacts emitted by command runtimes.
import path from 'node:path';
import { validateOperationRecord } from '@farmslot/protocol';
import type { TaskOperation, TaskProgressStructured } from '@farmslot/protocol';
import { slotFileExists, slotListDir, slotReadFile, type SlotLocality } from '../core/slot-io.js';

export async function attachOperations(
  ctx: SlotLocality,
  checklist: string,
  progress: TaskProgressStructured,
): Promise<void> {
  const taskDir = path.dirname(checklist);
  const directory = path.join(taskDir, 'artifacts', 'operations');
  try {
    if (!(await slotFileExists(ctx, directory))) return;
    const names = (await slotListDir(ctx, directory)).filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name),
    );
    const operations = await Promise.all(
      names.map(async (name) => {
        const value = JSON.parse(
          await slotReadFile(ctx, path.join(directory, name)),
        ) as TaskOperation;
        validateOperationRecord(value, name.slice(0, -5));
        // Links always address this record's task-local log, never an arbitrary supplied path.
        return { ...value, logPath: `artifacts/operations/${value.id}.log` };
      }),
    );
    progress.operations = operations.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  } catch (error) {
    progress.operationsError = `Operation progress unavailable: ${(error as Error).message}`;
  }
}
