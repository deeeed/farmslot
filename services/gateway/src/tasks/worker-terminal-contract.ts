import { createRequire } from 'node:module';
import path from 'node:path';

import {
  checklistBasenameFromTaskPath,
  type ExecResult,
  type Run,
  taskDirRelPath,
  terminalContractInputForChecklist,
  WORKER_TERMINAL_CONTRACT_INPUT,
  type WorkerSignal,
  type WorkerTerminalContractDocument,
  type WorkerTerminalProjectConfig,
} from '@farmslot/protocol';

import {
  farmslotRoot,
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveRemoteRepo,
  resolveTaskRelDir,
} from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
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

export function artifactTerminalCommandForSignal(
  signal: Pick<WorkerSignal, 'status' | 'disposition'>,
): 'complete' | 'no-change' | null {
  if (signal.status !== 'complete' && signal.status !== 'done') return null;
  if (signal.disposition === 'already_fixed' || signal.disposition === 'not_reproducible') {
    return 'no-change';
  }
  return 'complete';
}

export function artifactContractWorkerInstruction(
  message: string,
  terminalCommand: 'complete' | 'no-change' = 'complete',
): string {
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 1800);
  return (
    '[Orchestrator] Your completion signal was rejected by the artifact contract. ' +
    `Fix the listed artifact issue(s), then run ./mark ${terminalCommand} again. ${detail}`
  );
}

export function artifactContractWaiverArgs(
  signal: Pick<WorkerSignal, 'artifactWaivers'>,
): string[] {
  return signal.artifactWaivers?.learnings === true ? ['--skip-learnings'] : [];
}

export function terminalContractFailureKind(
  result: Pick<ExecResult, 'exitCode' | 'stdout' | 'stderr'>,
): 'artifact' | 'infrastructure' {
  const output = `${result.stderr}\n${result.stdout}`;
  return result.exitCode === 1 && /(?:^|\n)TASK_ARTIFACT_CONTRACT_FAIL(?:\n|$)/.test(output)
    ? 'artifact'
    : 'infrastructure';
}

export async function validateTerminalSignalArtifacts(
  slotId: string,
  signalJsonPath: string,
  signal: WorkerSignal,
  checklistTaskFile?: string | null,
): Promise<{ ok: true } | { ok: false; kind: 'artifact' | 'infrastructure'; message: string }> {
  const terminalCommand = artifactTerminalCommandForSignal(signal);
  if (!terminalCommand) return { ok: true };

  const vars = await loadSlotVars(slotId);
  const taskDir = path.posix.dirname(signalJsonPath);
  const checklistBasename = checklistBasenameFromTaskPath(checklistTaskFile);
  const contractInput = checklistBasename
    ? terminalContractInputForChecklist(checklistBasename)
    : WORKER_TERMINAL_CONTRACT_INPUT;
  const contractPath = `${taskDir}/${contractInput}`;
  const agentRoot = isLocal(vars.host, vars.machine)
    ? farmslotRoot
    : resolveRemoteRepo('~/farmslot-node', vars.osType, vars.sshUser);
  const checker = `${agentRoot}/packages/agent-runtime/scripts/check-task-artifact-contract.mjs`;
  const prerequisites = await execOnSlot(
    vars,
    `test -f ${shellQuote(checker)} && test -f ${shellQuote(contractPath)}`,
    { timeout: 10_000 },
  );
  if (prerequisites.exitCode !== 0) {
    return {
      ok: false,
      kind: 'infrastructure',
      message:
        'Farmslot terminal-contract infrastructure is missing on the slot. ' +
        `Expected checker ${checker} and contract ${contractPath}. Sync/deploy the Farmslot node, then resume the run; the worker cannot repair this.`,
    };
  }
  const checkerArgs = [
    'node',
    shellQuote(checker),
    shellQuote(taskDir),
    '--contract',
    shellQuote(contractPath),
    '--terminal',
    terminalCommand,
    ...artifactContractWaiverArgs(signal),
  ];
  const result = await execOnSlot(vars, checkerArgs.join(' '), {
    timeout: 60_000,
    maxBuffer: 256 * 1024,
  });
  if (result.exitCode === 0) return { ok: true };

  const detail = `${result.stderr}\n${result.stdout}`
    .trim()
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 4000);
  const kind = terminalContractFailureKind(result);
  return {
    ok: false,
    kind,
    message:
      kind === 'artifact'
        ? `Terminal SIGNAL.json was rejected by the worker artifact contract. ` +
          `Fix the listed artifacts, then run ./mark ${terminalCommand} again.\n\n${detail || `checker exited ${result.exitCode}`}`
        : `Farmslot terminal-contract validation infrastructure failed (exit ${result.exitCode}). ` +
          `Repair or redeploy the checker, then resume the run; the worker cannot repair this.\n\n${detail || 'No checker diagnostics were returned.'}`,
  };
}

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
  additionalArtifactPaths: readonly string[] = [],
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
      artifacts: [...new Set([...artifacts, ...additionalArtifactPaths])],
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
  additionalArtifactPaths: readonly string[] = [],
): Promise<void> {
  const projectVars = await loadProjectVars(vars.projectName);
  let contract = resolveWorkerTerminalContract(
    readWorkerTerminalProjectConfig(projectVars.projectJson as Record<string, unknown>),
    flowType,
    { mode },
  );
  if (reportPath) contract = withTerminalReportPath(contract, reportPath, additionalArtifactPaths);
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
