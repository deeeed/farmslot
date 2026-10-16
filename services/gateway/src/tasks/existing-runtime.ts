import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildHandoffMetadata,
  type HandoffMetadata,
  portableProjectRepo,
} from '@farmslot/agent-runtime';
import {
  enumerateChecklistCheckboxes,
  isLightweightInteractiveDevRun,
  type Run,
} from '@farmslot/protocol';
import { resolveProjectTaskDirName } from '@farmslot/slot-config';

import { loadProjectVars, loadSlotVars, type SlotVars } from '../core/config.js';

import { resolveConfiguredExecutionTemplateForSlot } from './execution-template-catalog.js';
import { initializeHostedTaskOnSlot, verifyHostedTaskOnSlot } from './hosted-task-init.js';
import {
  readWorkerTerminalProjectConfig,
  resolveWorkerTerminalContract,
  withTerminalReportPath,
} from './worker-terminal-contract.js';

interface AuthoredTaskContext extends Partial<
  Pick<Run, 'domain' | 'mode' | 'ticketData' | 'executionTemplateId' | 'devInteractiveProfile'>
> {
  taskFile: string;
  project: string;
  flowType: Run['flowType'];
  ticketOrPr: string;
  attemptId?: string;
}

export async function initializeExistingTaskRuntime(run: Run): Promise<void> {
  if (!run.taskFile) throw new Error('Existing task runtime requires its task');
  // A retained legacy session resumes with its original marker and metadata.
  if (
    run.metrics.runnerSessionId &&
    !existsSync(path.join(path.dirname(run.taskFile), 'artifacts/harness-provenance.json'))
  )
    return;
  const slot = run.slotId ? await loadSlotVars(run.slotId) : undefined;
  if (!slot) throw new Error('Existing task initialization requires its execution slot.');
  await initializeAuthoredTaskOnSlot(slot, { ...run, taskFile: run.taskFile, attemptId: run.id });
}

/** Direct dispatch and run adoption share the node producer; neither invents a Run. */
export async function initializeAuthoredTaskOnSlot(
  slot: SlotVars,
  run: AuthoredTaskContext,
): Promise<void> {
  const project = await loadProjectVars(run.project);
  const retained = existsSync(
    path.join(path.dirname(run.taskFile), 'artifacts/harness-provenance.json'),
  );
  const workerTaskDir = path.posix.join(
    slot.remoteRepo,
    resolveProjectTaskDirName(project.projectJson),
    path.basename(path.dirname(path.dirname(run.taskFile))),
    path.basename(path.dirname(run.taskFile)),
  );
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
  if (retained) {
    if (!authored) throw new Error('Retained task identity is missing its handoff.');
    await verifyHostedTaskOnSlot(slot, workerTaskDir);
    return;
  }
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
  let terminalContract = authoredContract;
  if (!terminalContract) {
    const configuredContract = resolveWorkerTerminalContract(
      readWorkerTerminalProjectConfig(project.projectJson as Record<string, unknown>),
      run.flowType,
      { mode: run.mode },
    );
    terminalContract = authored
      ? withTerminalReportPath(configuredContract, authored.report, [authored.learnings])
      : configuredContract;
  }
  const selected = resolveConfiguredExecutionTemplateForSlot(project, {
    flow: run.flowType,
    platform: slot.platform,
    runMode: run.mode ?? 'interactive',
    ...(run.domain ? { explicitDomain: run.domain } : {}),
    ...(slot.domain ? { slotDomain: slot.domain } : {}),
    ...(run.executionTemplateId ? { explicitId: run.executionTemplateId } : {}),
  });
  const handoff =
    authored ??
    buildHandoffMetadata({
      attemptId: run.attemptId ?? randomUUID(),
      surface: 'farmslot',
      project: run.project,
      flow: run.flowType,
      domain: selected.effectiveDomain ?? undefined,
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
  const checklistFile = path.join(path.dirname(run.taskFile), 'CHECKLIST.md');
  const checklistMarkdown = existsSync(checklistFile)
    ? await readFile(checklistFile, 'utf8')
    : !isLightweightInteractiveDevRun(run) && checklist
      ? `${checklist}\n`
      : null;
  await initializeHostedTaskOnSlot(slot, path.dirname(run.taskFile), {
    binding: project.projectJson.recipe?.provider ? 'project' : 'static',
    template: selected,
    task: {
      taskDir: workerTaskDir,
      flow: run.flowType,
      platform: slot.platform,
      runMode: run.mode ?? undefined,
      domain: selected.effectiveDomain ?? undefined,
      task: {
        title: run.ticketData?.title ?? run.ticketOrPr,
        sourceKind: 'text',
        acceptanceCriteria: run.ticketData?.acceptanceCriteria ?? [],
      },
      handoff: {
        surface: handoff.surface,
        project: handoff.project,
        attemptId: handoff.attemptId,
        repo: handoff.repo,
      },
      terminalContract,
      bugInput: run.ticketData ?? undefined,
      authored: { taskMarkdown: task, checklistMarkdown, handoff },
    },
  });
}
