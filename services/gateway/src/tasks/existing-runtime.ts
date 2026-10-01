import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildHandoffMetadata,
  ensureTaskRuntime,
  portableProjectRepo,
} from '@farmslot/agent-runtime';
import {
  enumerateChecklistCheckboxes,
  isLightweightInteractiveDevRun,
  type Run,
} from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars } from '../core/config.js';

import { markCommandForSlot } from './checklist-target.js';
import {
  readWorkerTerminalProjectConfig,
  resolveWorkerTerminalContract,
} from './worker-terminal-contract.js';

export async function initializeExistingTaskRuntime(run: Run): Promise<void> {
  if (!run.taskFile) throw new Error('Existing task runtime requires its task');
  const project = await loadProjectVars(run.project);
  const slot = run.slotId ? await loadSlotVars(run.slotId) : undefined;
  const task = await readFile(run.taskFile, 'utf8');
  let authored:
    | {
        domain?: string;
        startedAt?: string;
        task?: { ticket?: string; acceptanceCriteria?: string[] };
      }
    | undefined;
  try {
    authored = JSON.parse(
      await readFile(path.join(path.dirname(run.taskFile), 'inputs/handoff.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const terminalContract = resolveWorkerTerminalContract(
    readWorkerTerminalProjectConfig(project.projectJson as Record<string, unknown>),
    run.flowType,
    { mode: run.mode },
  );
  const handoff = buildHandoffMetadata({
    attemptId: run.id,
    surface: 'farmslot',
    project: run.project,
    flow: run.flowType,
    domain: run.domain ?? authored?.domain,
    repo: portableProjectRepo(project.projectJson as Record<string, unknown>),
    title: run.ticketData?.title ?? run.ticketOrPr,
    sourceKind: 'text',
    acceptanceCriteria:
      run.ticketData?.acceptanceCriteria ?? authored?.task?.acceptanceCriteria ?? [],
    ticket: authored?.task?.ticket ?? run.ticketOrPr,
    startedAt: authored?.startedAt,
    terminalContract,
  });
  const lines = task.split('\n');
  const checklist = enumerateChecklistCheckboxes(task)
    .map((item) => lines[item.lineIndex])
    .join('\n');
  await ensureTaskRuntime({
    taskDir: path.dirname(run.taskFile),
    checklistMarkdown: !isLightweightInteractiveDevRun(run) && checklist ? `${checklist}\n` : null,
    handoff,
    terminalContract,
    markCommand: slot ? markCommandForSlot(slot, project) : undefined,
    bugInput: run.ticketData ?? undefined,
  });
}
