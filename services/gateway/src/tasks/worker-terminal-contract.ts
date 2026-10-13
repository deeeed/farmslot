import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  checklistBasenameFromTaskPath,
  type DeterministicChecklistCheck,
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
  getOrchestratorTaskRoot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
  SlotConfigError,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { slotFileExists, type SlotLocality, slotReadFile } from '../core/slot-io.js';
import { shellQuote } from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';

import { AcceptanceReadError, handoffListsAcceptanceCriteria } from './acceptance-status.js';
import { agentRuntimeScriptForSlot } from './agent-runtime-script.js';
import { subtaskTerminalRefusal } from './subtasks.js';

const require = createRequire(import.meta.url);
const {
  resolveWorkerTerminalContract,
  deterministicChecks,
  lintWorkerTemplateAgainstContract,
  templateUsesTerminalMark,
} = require('@farmslot/agent-runtime/scripts/worker-terminal-contract.cjs') as {
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
  deterministicChecks: {
    outputPrefix: string;
    declarations: (markdown: string, checklist: string) => Array<{ stepNumber: number }>;
    freeze: (
      contract: WorkerTerminalContractDocument,
      markdown: string,
      checklist: string,
      commands: Record<string, string>,
    ) => WorkerTerminalContractDocument;
  };
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

/**
 * Did the project opt into ledger enforcement for this run? Reads the run's own
 * resolved contract on the slot. An unreadable contract answers false: the
 * checker's own `--contract` read is what reports a broken contract file, and
 * this predicate must not invent a gate the project never asked for.
 */
async function acceptanceRequiredByContract(
  vars: SlotLocality,
  contractPath: string,
): Promise<boolean> {
  try {
    if (!(await slotFileExists(vars, contractPath))) return false;
    const parsed: unknown = JSON.parse(await slotReadFile(vars, contractPath));
    if (!parsed || typeof parsed !== 'object') return false;
    const acceptance = (parsed as { acceptance?: unknown }).acceptance;
    if (!acceptance || typeof acceptance !== 'object') return false;
    return (acceptance as { require?: unknown }).require === true;
  } catch (err) {
    console.warn(
      `[worker-terminal] could not read ${contractPath} for the acceptance rule: ${(err as Error).message}`,
    );
    return false;
  }
}

export async function validateTerminalSignalArtifacts(
  slotId: string,
  signalJsonPath: string,
  signal: WorkerSignal,
  checklistTaskFile?: string | null,
): Promise<
  | { ok: true; deterministicChecks?: DeterministicChecklistCheck[] }
  | { ok: false; kind: 'artifact' | 'infrastructure'; message: string }
> {
  const terminalCommand = artifactTerminalCommandForSignal(signal);
  if (!terminalCommand) return { ok: true };

  const vars = await loadSlotVars(slotId);
  const taskDir = path.posix.dirname(signalJsonPath);

  // A registered child checklist unit (ADR-060) is part of this signal's proof.
  // The mark engine already refuses a parent terminal command with an open
  // child, but a signal written around the engine — by hand, by an older node's
  // `mark`, or by a runner that edited the file — would otherwise sail through,
  // so the gateway asserts it too, from the child signals on the slot. The
  // review-workspace completion read calls the same refusal on its own task dir.
  const openChild = await subtaskTerminalRefusal(vars, taskDir, terminalCommand);
  if (openChild) return { ok: false, kind: 'artifact', message: openChild };

  const checklistBasename = checklistBasenameFromTaskPath(checklistTaskFile);
  const contractInput = checklistBasename
    ? terminalContractInputForChecklist(checklistBasename)
    : WORKER_TERMINAL_CONTRACT_INPUT;
  const contractPath = `${taskDir}/${contractInput}`;
  // The acceptance ledger (ADR-060 phase 5) is part of this signal's proof for the
  // same reason as an open child: `mark complete` already requires a verdict per
  // criterion, and a signal written around the engine must not skip it.
  //
  // The opt-in emits a compatibility flag for older deployed checkers. Current
  // checkers enforce every registered verdict on complete without that flag too.
  // No-change retains its outcome contract; unreadable opted-in handoffs refuse
  // here, and the current checker refuses unreadable handoffs independently.
  let requiresAcceptanceLedger = false;
  if (terminalCommand === 'complete' && (await acceptanceRequiredByContract(vars, contractPath))) {
    try {
      requiresAcceptanceLedger = await handoffListsAcceptanceCriteria(vars, taskDir);
    } catch (err) {
      // Fail closed: a task whose criteria list cannot be read cannot have proven
      // them, and silently dropping the requirement is how an unproven run ships.
      if (!(err instanceof AcceptanceReadError)) throw err;
      return {
        ok: false,
        kind: 'artifact',
        message:
          `Terminal signal rejected: ${err.message}. The acceptance criteria (ADR-060) come from ` +
          `that file, so the gateway cannot tell whether every criterion has a verdict. Restore ` +
          `${err.file} from the orchestrator copy, then run ./mark ${terminalCommand} again.`,
      };
    }
  }

  const checker = await agentRuntimeScriptForSlot(vars, 'check-task-artifact-contract.mjs');
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
    ...(requiresAcceptanceLedger ? ['--require-acceptance-status'] : []),
    ...artifactContractWaiverArgs(signal),
  ];
  const result = await execOnSlot(vars, checkerArgs.join(' '), {
    timeout: 60_000,
    maxBuffer: 256 * 1024,
  });
  if (result.exitCode === 0) {
    const resultLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(deterministicChecks.outputPrefix));
    const checks = resultLine
      ? (JSON.parse(
          resultLine.slice(deterministicChecks.outputPrefix.length),
        ) as DeterministicChecklistCheck[])
      : [];
    if (!Array.isArray(checks))
      throw new Error('Invalid deterministic-check projection from the artifact checker');
    if (!checks.length) {
      const contract = JSON.parse(
        await slotReadFile(vars, contractPath),
      ) as WorkerTerminalContractDocument;
      if (contract.deterministicChecks?.length) {
        return {
          ok: false,
          kind: 'infrastructure',
          message:
            `Artifact checker ${checker} returned ${resultLine ? 'an empty' : 'no'} deterministic-check projection, ` +
            `but ${contractPath} declares ${contract.deterministicChecks.length} check(s). ` +
            'Verify the connected node runtime and the selected task/checklist contract; the CI receipts have not been verified.',
        };
      }
    }
    if (!resultLine) return { ok: true };
    return { ok: true, deterministicChecks: checks };
  }

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
  const localCheck = getProjectField(projectVars.projectJson, 'ci.local_check');
  const fullTaskDir = `${vars.remoteRepo}/${taskDirRelPath(taskDir, '')}`;
  const parentContractPath = `${fullTaskDir}/${WORKER_TERMINAL_CONTRACT_INPUT}`;
  if (!checklistBasename && (await slotFileExists(vars, parentContractPath))) {
    // Role cleanup restores the initialized parent's command, including TASK.md
    // for interactive dev. Current project configuration must not rewrite it.
    const initialized = JSON.parse(
      await slotReadFile(vars, parentContractPath),
    ) as WorkerTerminalContractDocument;
    if (initialized.deterministicChecks) {
      contract = { ...contract, deterministicChecks: initialized.deterministicChecks };
    }
  } else if (localCheck) {
    const checklist = checklistBasename ?? 'CHECKLIST.md';
    const markdown = await slotReadFile(vars, `${fullTaskDir}/${checklist}`);
    contract = deterministicChecks.freeze(contract, markdown, checklist, {
      'ci.local_check': localCheck,
    });
  }
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
    const contractPath = `${terminalTaskDirOnSlot(run, vars, projectVars)}/${WORKER_TERMINAL_CONTRACT_INPUT}`;
    const result = await execOnSlot(vars, `cat ${shellQuote(contractPath)} 2>/dev/null`);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return JSON.parse(result.stdout) as WorkerTerminalContractDocument;
    }
  } catch {
    // fall back to project/builtin contract
  }
  return fallback;
}

function terminalTaskDirOnSlot(
  run: Run,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  projectVars: Awaited<ReturnType<typeof loadProjectVars>>,
): string {
  const taskDir = resolveProjectTaskDirName(projectVars.projectJson);
  const orchRoot = getOrchestratorTaskRoot(run.project, projectVars.projectJson);
  const taskRel = resolveTaskRelDir(run.taskFile!, orchRoot) ?? '';
  return `${vars.remoteRepo}/${taskDir}/${taskRel}`;
}

/** Role cleanup clears activeTaskFile, but a completed fix owns the final source proof. */
export function deterministicChecklistTaskFileForPublication(run: Run): string | null {
  const fixes = (run.agentContexts ?? [])
    .filter(
      (context) =>
        (context.role === 'review-fix' || context.role === 'ci-fix') &&
        context.status === 'complete' &&
        context.taskFile,
    )
    .sort((a, b) =>
      (b.lastSignalAt ?? b.completedAt ?? b.attemptStartedAt ?? '').localeCompare(
        a.lastSignalAt ?? a.completedAt ?? a.attemptStartedAt ?? '',
      ),
    );
  const active = checklistBasenameFromTaskPath(run.activeTaskFile);
  if (active === 'REVIEW-FIX.md' || active === 'CI-FIX.md') return run.activeTaskFile!;
  return fixes[0]?.taskFile ?? run.taskFile;
}

/** Revalidate task-owned receipts on the selected checkout before publication. */
export async function validateDeterministicChecksForRun(
  run: Run,
): Promise<DeterministicChecklistCheck[]> {
  if (!run.taskFile) return [];
  const taskFile = deterministicChecklistTaskFileForPublication(run);
  const checklist = checklistBasenameFromTaskPath(taskFile);
  const input = checklist
    ? terminalContractInputForChecklist(checklist)
    : WORKER_TERMINAL_CONTRACT_INPUT;
  let vars: Awaited<ReturnType<typeof loadSlotVars>> | null = null;
  try {
    if (run.slotId) vars = await loadSlotVars(run.slotId);
  } catch (error) {
    if (!(error instanceof SlotConfigError) || error.code !== 'SLOT_NOT_FOUND') throw error;
    // Released legacy tasks can refresh from retained metadata. Any declaration
    // below still requires its selected checkout and therefore fails closed.
  }
  const projectVars = vars ? await loadProjectVars(run.project) : null;
  const taskDir =
    vars && projectVars
      ? terminalTaskDirOnSlot(run, vars, projectVars)
      : path.dirname(run.taskFile);
  const readTaskFile = async (relative: string): Promise<string | null> => {
    const file = path.join(taskDir, relative);
    if (vars) return (await slotFileExists(vars, file)) ? slotReadFile(vars, file) : null;
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }
  };
  const content = await readTaskFile(input);
  const contract: WorkerTerminalContractDocument | null = content ? JSON.parse(content) : null;
  if (!contract?.deterministicChecks?.length) {
    for (const checklist of new Set([
      'CHECKLIST.md',
      'TASK.md',
      ...(taskFile ? [path.basename(taskFile)] : []),
    ])) {
      const markdown = (await readTaskFile(checklist)) ?? '';
      if (deterministicChecks.declarations(markdown, checklist).length) {
        throw new Error(
          'Deterministic CI gate blocked: declared checks have no frozen task contract. Restore or initialize the task contract.',
        );
      }
    }
    return [];
  }
  if (!vars)
    throw new Error(
      'Deterministic CI checks require the run checkout; slot is missing or unavailable',
    );
  const result = await validateTerminalSignalArtifacts(
    vars.slotId,
    `${taskDir}/SIGNAL.json`,
    {
      status: 'complete',
      timestamp: new Date().toISOString(),
    },
    taskFile,
  );
  if (!result.ok) throw new Error(`Deterministic CI gate blocked: ${result.message}`);
  if (!result.deterministicChecks?.length) {
    throw new Error(
      `Deterministic CI gate blocked: no verified receipts were returned for ${taskDir}/${input}, ` +
        `which declares ${contract.deterministicChecks.length} check(s). Verify the selected task/checklist contract and rerun its CI mark step.`,
    );
  }
  return result.deterministicChecks;
}
