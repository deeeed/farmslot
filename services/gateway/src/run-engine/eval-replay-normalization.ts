import {
  FLOW_STEPS,
  type FlowType,
  PipelineSteps,
  type ResultPackageManifest,
  type Run,
  type RunStartRefProvenance,
} from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { readEvalExperimentManifest, readResultPackageManifest } from '../evals/package-store.js';
import { fetchGitHubPR } from '../external/github.js';
import { buildSmartBranch } from '../intelligence/engine.js';
import { getRun, updateRun } from '../runs/store.js';

function isSyntheticEvalTicket(ticketOrPr: string): boolean {
  return /^EVAL-[A-Z0-9][A-Z0-9-]{3,79}$/.test(ticketOrPr);
}
function evalReplayStepsForFlow(flowType: FlowType, currentSteps: Run['steps']): Run['steps'] {
  const existingByName = new Map(currentSteps.map((step) => [step.name, step]));
  return (FLOW_STEPS[flowType] ?? FLOW_STEPS['fix-bug']).map((name) => {
    const existing = existingByName.get(name);
    if (existing) return existing;
    if (name === 'grade') {
      return {
        name,
        status: 'done',
        detail: 'Skipped for recovered eval replay; reference ticket data is reused.',
        outputs: { skipped: true, reason: 'eval-replay-reference-ticket-data' },
      };
    }
    return { name, status: 'pending' };
  });
}
function sameStepNames(left: Run['steps'], right: Run['steps']): boolean {
  return (
    left.length === right.length && left.every((step, index) => step.name === right[index]?.name)
  );
}
async function resolveEvalReplayStartRef(
  current: Run,
  referencePackage: ResultPackageManifest,
  originalRun?: Run,
): Promise<RunStartRefProvenance> {
  if (current.startRef?.requestedRef) return current.startRef;
  const source = referencePackage.source;
  const sourceBaseSha =
    source.kind === 'merged-pr' || source.kind === 'git-ref' ? source.baseSha : undefined;
  const packagedBase =
    referencePackage.baseline?.baseSha ?? sourceBaseSha ?? referencePackage.diff.baseSha;
  if (packagedBase?.trim()) {
    return {
      requestedRef: packagedBase.trim(),
      source:
        source.kind === 'merged-pr'
          ? { kind: 'merged-pr', repo: source.repo, prNumber: source.prNumber }
          : source.kind === 'package' && source.packagePath
            ? { kind: 'package', packagePath: source.packagePath }
            : source.kind === 'git-ref'
              ? { kind: 'git-ref', repository: source.repository, ref: source.ref }
              : { kind: 'manual' },
    };
  }
  const originalStartRef =
    originalRun?.startRef?.resolvedSha ?? originalRun?.startRef?.requestedRef;
  if (originalStartRef?.trim()) {
    return {
      requestedRef: originalStartRef.trim(),
      source: originalRun?.startRef?.source ?? { kind: 'manual' },
    };
  }
  if (originalRun?.prNumber != null) {
    const projectVars = await loadProjectVars(current.project);
    const repo = (projectVars.projectJson as { ci?: { repo?: string } }).ci?.repo;
    if (repo) {
      const pr = await fetchGitHubPR(`${repo}#${originalRun.prNumber}`);
      if (pr.baseSha?.trim()) {
        return {
          requestedRef: pr.baseSha.trim(),
          source: { kind: 'merged-pr', repo, prNumber: originalRun.prNumber },
        };
      }
    }
  }
  const sourceLabel =
    source.kind === 'prior-run'
      ? `prior run ${source.runId.slice(0, 8)}`
      : source.kind === 'package'
        ? `package ${source.packageId}`
        : source.kind === 'merged-pr'
          ? `${source.repo}#${source.prNumber}`
          : source.ref;
  throw new Error(
    `Eval replay cannot prepare without a reference base commit/startRef; ${sourceLabel} has no baseline.baseSha, source.baseSha, diff.baseSha, original startRef, or resolvable PR base.`,
  );
}
export async function normalizeEvalReplayForTaskWrite(runId: string, current: Run): Promise<Run> {
  const evalState = current.engineState?.evalExperiment;
  if (!evalState || current.completionPolicy !== 'artifact-only' || current.lane !== 'comparison')
    return current;
  const experiment = await readEvalExperimentManifest(evalState.experimentManifestPath);
  const referencePackage = await readResultPackageManifest(experiment.case.referencePackagePath);
  const taskProfile = experiment.case.taskProfile;
  const originalRun =
    referencePackage.source.kind === 'prior-run'
      ? getRun(referencePackage.source.runId)
      : undefined;
  const nextStartRef = await resolveEvalReplayStartRef(current, referencePackage, originalRun);
  const nextTicketOrPr = originalRun?.ticketOrPr ?? current.ticketOrPr;
  const nextTicketData = originalRun?.ticketData ?? current.ticketData;
  const existingTaskFile = current.taskFile ?? taskFileFromWriteTaskOutput(current);
  const shouldRegenerateTask =
    current.flowType !== taskProfile ||
    (isSyntheticEvalTicket(current.ticketOrPr) && !existingTaskFile);
  const nextBranch = shouldRegenerateTask
    ? buildSmartBranch(taskProfile, nextTicketOrPr, undefined, undefined, current.variant)
    : current.branch;
  const startRefChanged =
    current.startRef?.requestedRef !== nextStartRef.requestedRef ||
    current.startRef?.source?.kind !== nextStartRef.source?.kind;
  const nextSteps = evalReplayStepsForFlow(taskProfile, current.steps);
  const stepsChanged = !sameStepNames(current.steps, nextSteps);
  if (
    !shouldRegenerateTask &&
    !startRefChanged &&
    !stepsChanged &&
    current.ticketOrPr === nextTicketOrPr &&
    current.ticketData === nextTicketData
  ) {
    return current;
  }
  const normalized = updateRun(runId, {
    flowType: taskProfile,
    ticketOrPr: nextTicketOrPr,
    familyRootTicketOrPr: nextTicketOrPr,
    ticketData: nextTicketData,
    branch: nextBranch,
    startRef: nextStartRef,
    steps: nextSteps,
    taskFile: shouldRegenerateTask ? null : existingTaskFile,
  });
  if (shouldRegenerateTask) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — regenerating eval replay task as ${taskProfile} from reference ${nextTicketOrPr}`,
    );
  }
  if (startRefChanged) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — replay base set to ${nextStartRef.requestedRef}`,
    );
  }
  return normalized;
}

function taskFileFromWriteTaskOutput(run: Run): string | null {
  const writeTaskStep = run.steps.find((step) => step.name === PipelineSteps.WRITE_TASK);
  const taskFile = writeTaskStep?.outputs?.taskFile;
  return typeof taskFile === 'string' && taskFile.trim() ? taskFile : null;
}
