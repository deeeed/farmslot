import { createRequire } from 'node:module';

import {
  type Run,
  taskDirRelPath,
  terminalContractInputForChecklist,
  WORKER_TERMINAL_CONTRACT_INPUT,
  type WorkerTerminalContractDocument,
  type WorkerTerminalProjectConfig,
} from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';

const require = createRequire(import.meta.url);
const {
  resolveWorkerTerminalContract,
  lintWorkerTemplateAgainstContract,
  templateUsesTerminalMark,
} = require('../../../../scripts/quality/worker-terminal-contract.cjs') as {
  resolveWorkerTerminalContract: (
    config: WorkerTerminalProjectConfig | null | undefined,
    flowType: string,
    options?: { mode?: string | null; now?: string },
  ) => WorkerTerminalContractDocument;
  lintWorkerTemplateAgainstContract: (
    templateContent: string,
    contract: WorkerTerminalContractDocument,
  ) => string[];
  templateUsesTerminalMark: (content: string) => boolean;
};

export {
  lintWorkerTemplateAgainstContract,
  resolveWorkerTerminalContract,
  templateUsesTerminalMark,
};

export function readWorkerTerminalProjectConfig(
  projectJson: Record<string, unknown>,
): WorkerTerminalProjectConfig | null {
  const raw = projectJson.worker_terminal;
  if (!raw || typeof raw !== 'object') return null;
  return raw as WorkerTerminalProjectConfig;
}

export function withTerminalReportPath(
  contract: WorkerTerminalContractDocument,
  reportPath: string,
): WorkerTerminalContractDocument {
  const commands = { ...contract.commands };
  for (const command of ['complete', 'no-change'] as const) {
    const current = contract.commands[command];
    const artifacts = current.report
      ? current.artifacts.map((artifact) => (artifact === current.report ? reportPath : artifact))
      : [...current.artifacts, reportPath];
    commands[command] = {
      ...current,
      report: reportPath,
      artifacts: [...new Set(artifacts)],
    };
  }
  return { ...contract, commands };
}

export async function syncTerminalContractForFlowOnSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  flowType: string,
  mode?: string | null,
  reportPath?: string,
  checklistBasename?: string,
): Promise<void> {
  const projectVars = await loadProjectVars(vars.projectName);
  let contract = resolveWorkerTerminalContract(
    readWorkerTerminalProjectConfig(projectVars.projectJson as Record<string, unknown>),
    flowType,
    { mode },
  );
  if (reportPath) contract = withTerminalReportPath(contract, reportPath);
  await writeTextFileOnSlot(
    vars,
    taskDirRelPath(
      taskDir,
      checklistBasename
        ? terminalContractInputForChecklist(checklistBasename)
        : WORKER_TERMINAL_CONTRACT_INPUT,
    ),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
}

export async function loadTerminalContractForRun(
  run: Run,
  slotId: string,
): Promise<WorkerTerminalContractDocument> {
  const projectVars = await loadProjectVars(run.project);
  const fallback = resolveWorkerTerminalContract(
    readWorkerTerminalProjectConfig(projectVars.projectJson as Record<string, unknown>),
    run.flowType,
    { mode: run.mode ?? undefined },
  );
  if (!run.taskFile) return fallback;

  try {
    const vars = await loadSlotVars(slotId);
    const taskDir = resolveProjectTaskDirName(projectVars.projectJson);
    const orchRoot = getOrchestratorTaskRoot(run.project, projectVars.projectJson);
    const taskRel = resolveTaskRelDir(run.taskFile, orchRoot) ?? '';
    const contractPath = `${vars.remoteRepo}/${taskDir}/${taskRel}/${WORKER_TERMINAL_CONTRACT_INPUT}`;
    const result = await execOnSlot(vars, `cat ${shellQuote(contractPath)} 2>/dev/null`);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return JSON.parse(result.stdout) as WorkerTerminalContractDocument;
    }
  } catch {
    // fall back to project/builtin contract
  }
  return fallback;
}
