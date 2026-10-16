import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  checklistBasenameFromTaskPath,
  type DeterministicChecklistCheck,
  type ExecResult,
  primaryRoleForFlow,
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
  const fullTaskDir = `${vars.remoteRepo}/${taskDirRelPath(taskDir, '')}`;
  const parentContractPath = `${fullTaskDir}/${WORKER_TERMINAL_CONTRACT_INPUT}`;
  // Role cleanup restores the initialized parent, including its gateway policy
  // and frozen CI commands. Project defaults must never replace that contract.
  if (!checklistBasename && (await slotFileExists(vars, parentContractPath))) return;
  const projectVars = await loadProjectVars(vars.projectName);
  let contract = resolveWorkerTerminalContract(
    readWorkerTerminalProjectConfig(projectVars.projectJson as Record<string, unknown>),
    flowType,
    { mode },
  );
  if (checklistBasename && (await slotFileExists(vars, parentContractPath))) {
    // A nested role changes its artifacts and CI commands, not the run's frozen
    // claim-review authority or evidence-contract era.
    const parent: WorkerTerminalContractDocument = JSON.parse(
      await slotReadFile(vars, parentContractPath),
    );
    contract = {
      ...contract,
      claimReviewGate: parent.claimReviewGate,
      recordedEvidenceContractVersion: parent.recordedEvidenceContractVersion,
    };
  }
  if (reportPath) contract = withTerminalReportPath(contract, reportPath, additionalArtifactPaths);
  const localCheck = getProjectField(projectVars.projectJson, 'ci.local_check');
  if (localCheck) {
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

/** Replay restores dispatch authority; it never derives a new verdict policy. */
export async function readFrozenWorkerTerminalContractForRun(
  run: Pick<
    Run,
    | 'id'
    | 'project'
    | 'flowType'
    | 'mode'
    | 'taskFile'
    | 'recordedEvidenceContractVersion'
    | 'steps'
  >,
): Promise<string | null> {
  if (!run.taskFile) return null;
  // WRITE_TASK records this when it adopts an authored task instead of producing
  // a dispatch contract. Its task-init identity and policy remain author-owned.
  if (run.steps.some((step) => step.name === 'write-task' && step.outputs?.skipped === true)) {
    return null;
  }
  const taskDir = path.dirname(run.taskFile);
  let text: string;
  try {
    text = await readFile(path.join(taskDir, WORKER_TERMINAL_CONTRACT_INPUT), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!run.recordedEvidenceContractVersion) return null;
    throw new Error(
      'The frozen dispatch terminal contract is missing. Restore the retained task before replay.',
    );
  }
  const contract: unknown = JSON.parse(text);
  const handoff: unknown = JSON.parse(
    await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8'),
  );
  if (
    !handoff ||
    typeof handoff !== 'object' ||
    !('attemptId' in handoff) ||
    handoff.attemptId !== run.id ||
    !('project' in handoff) ||
    handoff.project !== run.project ||
    !('flow' in handoff) ||
    handoff.flow !== run.flowType ||
    !contract ||
    typeof contract !== 'object' ||
    !('schemaVersion' in contract) ||
    contract.schemaVersion !== 1 ||
    !('flowType' in contract) ||
    contract.flowType !== run.flowType ||
    ('mode' in contract ? contract.mode : null) !== (run.mode ?? null) ||
    ('recordedEvidenceContractVersion' in contract
      ? contract.recordedEvidenceContractVersion
      : 0) !== (run.recordedEvidenceContractVersion ?? 0)
  ) {
    throw new Error(
      'The frozen dispatch terminal contract does not belong to this run. Restore the retained task before replay.',
    );
  }
  return text;
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

/** The latest completed source worker owns CI proof after its role target is restored. */
export function deterministicChecklistTaskFileForPublication(
  run: Pick<Run, 'flowType' | 'taskFile' | 'activeTaskFile' | 'agentContexts'>,
): string | null {
  const fixes = (run.agentContexts ?? [])
    .filter(
      (context) =>
        (context.role === primaryRoleForFlow(run.flowType) ||
          context.role === 'review-fix' ||
          context.role === 'ci-fix') &&
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
  // CI receipts belong to this checkout. Acceptance has its own gate and may
  // come from a verified parent; re-running the entire terminal contract here
  // would incorrectly demand a second task-bound acceptance ledger.
  const checker = await agentRuntimeScriptForSlot(vars, 'worker-terminal-contract.cjs');
  const checklists = [...new Set(contract.deterministicChecks.map((check) => check.checklist))];
  const evaluate = [
    'const {deterministicChecks}=require(process.argv[1]);',
    'const results=JSON.parse(process.argv[3]).map(c=>deterministicChecks.evaluate(process.argv[2],c));',
    'process.stdout.write(JSON.stringify(results));',
    'process.exitCode=results.some(r=>r.issues.length)?1:0;',
  ].join('');
  const result = await execOnSlot(
    vars,
    [
      'node',
      '-e',
      shellQuote(evaluate),
      shellQuote(checker),
      shellQuote(taskDir),
      shellQuote(JSON.stringify(checklists)),
    ].join(' '),
    { timeout: 60_000, maxBuffer: 256 * 1024 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Deterministic CI gate blocked: ${result.stderr || result.stdout}`);
  const evaluated: Array<{ checks: DeterministicChecklistCheck[]; issues: string[] }> = JSON.parse(
    result.stdout,
  );
  const checks = evaluated.flatMap((item) => item.checks);
  if (
    !checks.length ||
    evaluated.some((item) => item.issues.length > 0) ||
    checks.some((check) => check.status !== 'passed') ||
    contract.deterministicChecks.some(
      (expected) =>
        !checks.some(
          (check) =>
            check.checklist === expected.checklist &&
            check.stepNumber === expected.stepNumber &&
            check.reference === expected.reference &&
            check.command === expected.command,
        ),
    )
  ) {
    throw new Error(
      `Deterministic CI gate blocked: no verified receipts were returned for ${taskDir}/${input}, ` +
        `which declares ${contract.deterministicChecks.length} check(s). Verify the selected task/checklist contract and rerun its CI mark step.`,
    );
  }
  return checks;
}
