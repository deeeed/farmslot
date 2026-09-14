import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ROOT } from './common.mjs';

const require = createRequire(import.meta.url);
const { resolveChecklistTarget } = require(
  path.join(ROOT, 'packages/agent-runtime/scripts/checklist-target.cjs'),
);

export function fixtureChecklistPath(cwd, taskFile) {
  const taskDir = path.dirname(path.resolve(cwd, taskFile));
  return path.join(taskDir, resolveChecklistTarget(taskDir).checklist);
}

/** Operator-supplied validation plans use the same task-dir producer as a real dispatch. */
export async function writeNativeFixtureTask(taskFile, checklistMarkdown, project, options = {}) {
  const { buildHandoffMetadata, buildTaskDocument, builtinTerminalContract, writeTaskDir } =
    await import('@farmslot/agent-runtime');
  const taskDir = path.dirname(taskFile);
  const title = path.basename(taskDir);
  const flow = path.basename(path.dirname(taskDir));
  const taskLabel = `.task/${flow}/${title}`;
  const terminalContract = builtinTerminalContract(flow, { mode: 'interactive' });
  const handoff = buildHandoffMetadata({
    attemptId: randomUUID(),
    surface: 'runner-validation',
    project,
    flow,
    title,
    sourceKind: 'text',
    ticket: title,
    terminalContract,
  });
  const taskMarkdown = buildTaskDocument({
    flowType: flow,
    modePreamble:
      "> Operator-controlled validation. Follow the checklist's stopping rule. Terminal commands below are examples, not permission to finish early.",
    vars: {
      TITLE: title,
      TICKET: title,
      FLOW: flow,
      MODE: 'interactive',
      PLATFORM: 'cli',
      TASK_DIR: taskLabel,
    },
    description:
      options.description ??
      'Execute the supplied isolated transport-validation checklist. Do not publish, commit, contact services, or change files outside the requested fixture.',
    acceptanceCriteria: [],
    hasTicketData: false,
  });
  await writeTaskDir({
    taskDir,
    taskMarkdown,
    checklistMarkdown,
    handoff,
    terminalContract,
    ...(options.markCommand ? { markCommand: options.markCommand } : {}),
  });
  return taskFile;
}
