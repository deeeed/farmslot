import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import {
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  signalFileForChecklist,
} from '@farmslot/protocol/checklist-target';

import {
  slotCopyFile,
  type SlotCopyFileOptions,
  slotFileExists,
  type SlotLocality,
} from '../core/slot-io.js';
import { publishProgressResources } from '../resources/run-changes.js';

import { WORKER_MIRROR_SUFFIX } from './sidecars.js';

/** Both gate acquisition and final capture retain every task-root checklist and its timing signal. */
export async function mirrorWorkerProgress(
  io: SlotLocality,
  workerTaskDir: string,
  taskDir: string,
  run: Run,
  options: SlotCopyFileOptions = {},
): Promise<number> {
  const registry = DEFAULT_CHECKLIST_TARGET_REGISTRY;
  const documents = new Set([
    registry.workerTask,
    registry.interactiveChecklist,
    ...Object.values(registry.roles).map((target) => target.checklist),
    ...[run.activeTaskFile, ...(run.agentContexts ?? []).map((context) => context.taskFile)]
      .filter((file): file is string => !!file && file.endsWith('.md'))
      .map((file) => path.basename(file)),
  ]);
  const signals = new Set<string>();
  let copied = 0;
  const copy = async (file: string) => {
    const source = path.join(workerTaskDir, file);
    if (!(await slotFileExists(io, source))) return;
    const destination = `${file}${WORKER_MIRROR_SUFFIX}`;
    if (
      await slotCopyFile(io, source, path.join(taskDir, destination), {
        ...options,
        label: destination,
      })
    )
      copied += 1;
  };
  // TASK.md and CHECKLIST.md share a signal. No new terminal signal may admit
  // a previous body if a later checklist copy fails.
  for (const document of documents) {
    if (!(await slotFileExists(io, path.join(workerTaskDir, document)))) continue;
    await copy(document);
    signals.add(signalFileForChecklist(document));
  }
  for (const signal of signals) await copy(signal);
  if (copied) publishProgressResources(run.slotId ?? '', run.id);
  return copied;
}
