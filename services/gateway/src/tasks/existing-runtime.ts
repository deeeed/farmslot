import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildHandoffMetadata,
  ensureTaskRuntime,
  type HandoffMetadata,
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
  let authored: HandoffMetadata | undefined;
  try {
    authored = JSON.parse(
      await readFile(path.join(path.dirname(run.taskFile), 'inputs/handoff.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (authored && (authored.project !== run.project || authored.flow !== run.flowType))
    throw new Error('Existing task handoff belongs to a different project or flow');
  let authoredContract: ReturnType<typeof resolveWorkerTerminalContract> | undefined;
  try {
    authoredContract = JSON.parse(
      await readFile(
        path.join(path.dirname(run.taskFile), 'inputs/worker-terminal-contract.json'),
        'utf8',
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const terminalContract =
    authoredContract ??
    resolveWorkerTerminalContract(
      readWorkerTerminalProjectConfig(project.projectJson as Record<string, unknown>),
      run.flowType,
      { mode: run.mode },
    );
  const handoff =
    authored ??
    buildHandoffMetadata({
      attemptId: run.id,
      surface: 'farmslot',
      project: run.project,
      flow: run.flowType,
      domain: run.domain,
      repo: portableProjectRepo(project.projectJson as Record<string, unknown>),
      title: run.ticketData?.title ?? run.ticketOrPr,
      sourceKind: 'text',
      acceptanceCriteria: run.ticketData?.acceptanceCriteria ?? [],
      ticket: run.ticketOrPr,
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
