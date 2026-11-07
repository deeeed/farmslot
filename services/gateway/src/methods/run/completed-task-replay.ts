import path from 'node:path';

import type { TaskProvenance } from '@farmslot/agent-runtime';
import {
  type ExecutionTemplateReference,
  isExecutionTemplateReference,
  primaryRoleForFlow,
  type Run,
  type TemplateProvenance,
} from '@farmslot/protocol';
import { resolveTaskRelDir } from '@farmslot/slot-config';

import { sameTask } from '../../runs/task-execution.js';

export interface CompletedTaskReplayReaders {
  taskRoot(run: Run): Promise<string>;
  handoff(taskFile: string): Promise<string>;
  capturedHandoff(run: Run): Promise<string>;
  assertContract(run: Run): Promise<void>;
  provenance(taskFile: string): Promise<TaskProvenance | null>;
}

export interface CompletedTaskReplayBinding {
  taskFile: string;
  executionTemplate: ExecutionTemplateReference;
  templateProvenance?: TemplateProvenance;
}

/** A failed earlier-step replay must not replace the task that produced completed work. */
export function completedTaskReplayAnchor(run: Run, stepName: string): string | null {
  if (
    stepName !== 'complete' ||
    !['dev', 'fix-bug'].includes(run.flowType) ||
    !run.output?.workerFinished ||
    run.output.closedAt ||
    run.readOnly ||
    run.engineState?.operatorForceCompleted ||
    !['failed', 'blocked', 'cancelled'].includes(run.status)
  )
    return null;
  const taskFile = run.engineState?.taskExecution?.taskFile;
  if (!taskFile || !run.taskFile || sameTask(taskFile, run.taskFile)) return null;
  const context = run.agentContexts?.find(
    (entry) => entry.role === primaryRoleForFlow(run.flowType),
  );
  if (!sameTask(context?.taskFile, taskFile))
    throw new Error('Completed worker and execution task bindings differ; restoration refused.');
  return taskFile;
}

export async function readCompletedTaskReplayBinding(
  run: Run,
  stepName: string,
  readers: CompletedTaskReplayReaders,
): Promise<CompletedTaskReplayBinding | null> {
  const taskFile = completedTaskReplayAnchor(run, stepName);
  if (!taskFile) return null;
  if (
    !path.isAbsolute(taskFile) ||
    resolveTaskRelDir(taskFile, await readers.taskRoot(run)) === null
  )
    throw new Error('Completed task is outside this project task root.');
  const [handoff, captured] = await Promise.all([
    readers.handoff(taskFile),
    readers.capturedHandoff(run),
  ]);
  if (handoff !== captured)
    throw new Error(
      'Completed task inputs differ from their retained capture; restoration refused.',
    );
  await readers.assertContract({ ...run, taskFile });
  const provenance = await readers.provenance(taskFile);
  if (!isExecutionTemplateReference(provenance?.executionTemplate))
    throw new Error('Completed task template provenance is missing or invalid.');
  const executionTemplate = provenance.executionTemplate;
  return {
    taskFile,
    executionTemplate,
    ...(provenance.templateProvenance
      ? { templateProvenance: { ...provenance.templateProvenance, executionTemplate } }
      : {}),
  };
}
