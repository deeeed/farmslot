import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { normalizeMaintenanceBranch } from '@farmslot/agent-runtime';
import {
  type BranchMaintenanceCheckpoint,
  type BranchMaintenanceOperation,
  PipelineSteps,
  type Run,
} from '@farmslot/protocol';

import { emptyCiWatchState } from '../ci-monitor/state.js';
import { loadSlotVars, type SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { captureCurrentReviewSnapshot } from '../review/snapshots.js';
import {
  readReadyGatePreparedPackage,
  verifyReadyGatePackageHash,
} from '../run-completion/ready-gate-package.js';
import {
  commitRunPublication,
  getRun,
  getRunWithArchived,
  persistRunNow,
  updateRun,
} from '../runs/store.js';
import { agentRuntimeScriptForSlot } from '../tasks/agent-runtime-script.js';

import {
  contributionDiffBaseSpec,
  contributionLineage,
  settleStackedDiffBase,
} from './diff-artifacts.js';
import { publicationBaseForRun } from './stack-base.js';

async function runtimeOperation<T>(vars: SlotVars, phase: string, input: unknown): Promise<T> {
  const script = await agentRuntimeScriptForSlot(vars, 'branch-update.mjs');
  const result = await execOnSlot(
    vars,
    `node ${shellQuote(script)} ${shellQuote(phase)} ${shellQuote(JSON.stringify(input))}`,
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n').at(-1) ?? '';
    let refusal: { code?: string; message?: string } | undefined;
    try {
      refusal = JSON.parse(detail);
    } catch {
      throw new Error(`Branch maintenance ${phase} failed: ${detail || result.stdout}`);
    }
    throw new MaintenanceRefusal(refusal?.code ?? 'RUNTIME_FAILED', refusal?.message);
  }
  return JSON.parse(result.stdout.trim()) as T;
}

export class MaintenanceRefusal extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `Branch maintenance refused: ${code}`);
  }
}

interface MaintenanceDependencies {
  runtime: typeof runtimeOperation;
  loadSlot: typeof loadSlotVars;
  capture: typeof captureCurrentReviewSnapshot;
  comparison: typeof initialComparisonBase;
}

async function initialComparisonBase(
  vars: SlotVars,
  owner: Run,
  stack: NonNullable<Run['stack']>,
  defaultBranch: string,
  headSha: string,
): Promise<string> {
  const exec = (command: string) => execOnSlot(vars, command, { timeout: 15_000 });
  const base = await settleStackedDiffBase(
    exec,
    defaultBranch,
    contributionDiffBaseSpec({ startRef: owner.startRef, stack }, defaultBranch),
    headSha,
  );
  if (base.diffFrom) return base.diffFrom;
  const resolved = await exec(
    `git merge-base ${shellQuote(base.commitish)} ${shellQuote(headSha)}`,
  );
  if (resolved.exitCode !== 0 || !resolved.stdout.trim())
    throw new MaintenanceRefusal(
      'PARENT_BOUNDARY_MISSING',
      'Initial child comparison is unavailable.',
    );
  return resolved.stdout.trim();
}

const defaultDependencies: MaintenanceDependencies = {
  runtime: runtimeOperation,
  loadSlot: loadSlotVars,
  capture: captureCurrentReviewSnapshot,
  comparison: initialComparisonBase,
};

interface MaintenanceValidation {
  status: 'pending' | 'pushed' | 'stale';
  reason?: string;
}

export function pendingBranchMaintenance(
  run: Run | undefined,
): BranchMaintenanceOperation | undefined {
  if (!run) return undefined;
  if (run.ciWatchState?.branchMaintenanceOperation)
    return run.ciWatchState.branchMaintenanceOperation;
  const output = run.steps.find((step) => step.name === PipelineSteps.WRITE_TASK)?.outputs;
  return output?.branchMaintenanceCompleted
    ? undefined
    : (output?.branchMaintenanceOperation as BranchMaintenanceOperation | undefined);
}

/** Reset ordinary step telemetry without dropping immutable maintenance input. */
export function retainedMaintenanceStepOutputs(
  stepName: string,
  outputs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (stepName !== PipelineSteps.WRITE_TASK || !outputs?.branchMaintenanceOperation)
    return undefined;
  return {
    branchMaintenanceOperation: outputs.branchMaintenanceOperation,
    ...(outputs.branchMaintenanceCompleted !== undefined
      ? { branchMaintenanceCompleted: outputs.branchMaintenanceCompleted }
      : {}),
  };
}

/** Retire only this input. The previous publishing checkpoint remains authoritative. */
export async function retireBranchMaintenance(
  run: Run,
  explicitOperation?: BranchMaintenanceOperation,
  deps: MaintenanceDependencies = defaultDependencies,
): Promise<void> {
  const operation = explicitOperation ?? pendingBranchMaintenance(getRun(run.id) ?? run);
  if (!operation) return;
  if (!run.slotId) throw new MaintenanceRefusal('MAINTENANCE_SLOT_MISSING');
  const vars = await deps.loadSlot(run.slotId);
  if (vars.remoteRepo !== operation.repo)
    throw new MaintenanceRefusal('MAINTENANCE_CHECKOUT_CHANGED');
  const validation = await deps.runtime<MaintenanceValidation>(vars, 'validate', operation);
  if (validation.status === 'pushed') {
    await completeBranchMaintenance(run, operation, deps);
    return;
  }
  // The SDK preserves verified local work before an input can be replaced.
  await deps.runtime(vars, 'retire', { operation, recoverLocal: true });
  await retireMaintenanceInput(run.id, operation.id);
}

async function retireMaintenanceInput(runId: string, operationId: string): Promise<void> {
  const latest = getRun(runId);
  if (!latest) throw new MaintenanceRefusal('MAINTENANCE_RUN_MISSING');
  await persistRunNow(
    updateRun(runId, {
      ...(latest.ciWatchState?.branchMaintenanceOperation?.id === operationId
        ? { ciWatchState: { ...latest.ciWatchState, branchMaintenanceOperation: undefined } }
        : {}),
      steps: latest.steps.map((step) =>
        step.name === PipelineSteps.WRITE_TASK &&
        (step.outputs?.branchMaintenanceOperation as BranchMaintenanceOperation | undefined)?.id ===
          operationId
          ? {
              ...step,
              outputs: {
                ...step.outputs,
                branchMaintenanceOperation: undefined,
                branchMaintenanceCompleted: false,
              },
            }
          : step,
      ),
    }),
    'maintenance input retired',
  );
}

/** Terminal work keeps its checkout for inspection; input retirement grants no approval. */
export async function abandonBranchMaintenance(
  run: Run,
  deps: MaintenanceDependencies = defaultDependencies,
): Promise<void> {
  const operation = pendingBranchMaintenance(getRun(run.id) ?? run);
  if (!operation) return;
  if (!run.slotId) throw new MaintenanceRefusal('MAINTENANCE_SLOT_MISSING');
  const vars = await deps.loadSlot(run.slotId);
  if (vars.remoteRepo !== operation.repo)
    throw new MaintenanceRefusal('MAINTENANCE_CHECKOUT_CHANGED');
  // A terminal disposition cannot discard a successful push. Validation and
  // renewal only read Git; unpublished dirty work remains available for inspection.
  const validation = await deps.runtime<MaintenanceValidation>(vars, 'validate', operation);
  if (validation.status === 'pushed') await completeBranchMaintenance(run, operation, deps);
  else await retireMaintenanceInput(run.id, operation.id);
}

/** Graph transport uses the same pinned execution and exact lease as worker maintenance. */
export async function executeBranchMaintenance(
  vars: SlotVars,
  operation: BranchMaintenanceOperation,
  deps: MaintenanceDependencies = defaultDependencies,
): Promise<void> {
  const validation = await deps.runtime<MaintenanceValidation>(vars, 'validate', operation);
  if (validation.status === 'pushed') return;
  await deps.runtime(vars, 'execute', operation);
  await deps.runtime(vars, 'push', operation);
}

/** One input owner for maintenance tasks, inline fixes and graph catch-up. */
export async function prepareBranchMaintenance(
  run: Run,
  vars: SlotVars,
  defaultBranch: string,
  kind: BranchMaintenanceOperation['kind'] = 'rebase',
  deps: MaintenanceDependencies = defaultDependencies,
): Promise<BranchMaintenanceOperation | undefined> {
  const lineage: Run[] = [];
  for await (const candidate of contributionLineage(getRun(run.id) ?? run)) lineage.push(candidate);
  const stack = lineage.find((candidate) => candidate.stack)?.stack;
  if (!stack) return undefined;
  if (stack.retargetedTo && !stack.upstreamMergeSha)
    throw new MaintenanceRefusal('RETARGET_PROVENANCE_MISSING');
  const baseRef = await publicationBaseForRun(getRun(run.id) ?? run, defaultBranch);
  const pending = pendingBranchMaintenance(getRun(run.id) ?? run);
  if (pending) {
    if (pending.repo !== vars.remoteRepo)
      throw new MaintenanceRefusal('MAINTENANCE_CHECKOUT_CHANGED');
    if (pending.project !== run.project) throw new MaintenanceRefusal('MAINTENANCE_BASE_CHANGED');
    const validation = await deps.runtime<MaintenanceValidation>(vars, 'validate', pending);
    if (validation.status === 'pushed') {
      // A replay of the same task retains its exact command input. Complete
      // reconciles that verified push; changing the input would strand its receipt.
      if (pending.kind === kind && pending.baseRef === normalizeMaintenanceBranch(baseRef))
        return pending;
      await completeBranchMaintenance(run, pending, deps);
      return prepareBranchMaintenance(getRun(run.id) ?? run, vars, defaultBranch, kind, deps);
    } else if (
      validation.status === 'stale' ||
      pending.baseRef !== normalizeMaintenanceBranch(baseRef)
    ) {
      await retireBranchMaintenance(run, pending, deps);
    } else {
      if (pending.kind !== kind) throw new MaintenanceRefusal('MAINTENANCE_OPERATION_PENDING');
      return pending;
    }
  }
  let owner: Run | undefined;
  let checkpoint: BranchMaintenanceCheckpoint | undefined;
  let headSha: string | undefined;
  let comparisonBaseSha: string | undefined;
  let replayBoundarySha: string | undefined;
  for (const candidate of lineage) {
    if (
      !('id' in candidate) ||
      candidate.project !== run.project ||
      !candidate.prNumber ||
      (run.branch &&
        normalizeMaintenanceBranch(candidate.branch ?? '') !==
          normalizeMaintenanceBranch(run.branch))
    )
      continue;
    checkpoint = candidate.engineState?.publishGate?.maintainedSnapshot;
    if (checkpoint) {
      owner = candidate;
      headSha = checkpoint.headSha ?? undefined;
      comparisonBaseSha = checkpoint.baseSha ?? undefined;
      replayBoundarySha = checkpoint.replayBoundarySha;
      break;
    }
    const prepared = await readReadyGatePreparedPackage(candidate);
    if (!prepared || candidate.engineState?.publishGate?.packageHash !== prepared.packageHash)
      continue;
    verifyReadyGatePackageHash(prepared);
    if (prepared.supersededByPackageId || prepared.headSha !== prepared.reviewSnapshot?.headSha)
      continue;
    owner = candidate;
    headSha = prepared.headSha ?? undefined;
    comparisonBaseSha = headSha
      ? await deps.comparison(vars, candidate, stack, defaultBranch, headSha)
      : undefined;
    replayBoundarySha = stack.resolvedSha;
    break;
  }
  if (!owner || !headSha || !comparisonBaseSha || !replayBoundarySha || !owner.branch)
    throw new Error('PARENT_BOUNDARY_MISSING: recorded stack publication ownership is required.');
  const operation = await deps.runtime<BranchMaintenanceOperation>(vars, 'inspect', {
    id: randomUUID(),
    ownerRunId: owner.id,
    project: owner.project,
    repo: vars.remoteRepo,
    branch: owner.branch,
    baseRef,
    kind,
    authority: { headSha, comparisonBaseSha, replayBoundarySha },
    ...(checkpoint ? { expectedCheckpoint: checkpoint } : {}),
    ...(stack.upstreamMergeSha ? { upstreamMergeSha: stack.upstreamMergeSha } : {}),
  });
  const latest = getRun(run.id);
  if (!latest) throw new Error('Maintenance run is no longer active.');
  const raced = pendingBranchMaintenance(latest);
  if (raced) {
    if (raced.kind !== kind) throw new MaintenanceRefusal('MAINTENANCE_OPERATION_PENDING');
    return raced;
  }
  if (kind === 'graph-merge') {
    const updated = updateRun(run.id, {
      ciWatchState: {
        ...emptyCiWatchState(),
        ...latest.ciWatchState,
        branchMaintenanceOperation: operation,
      },
    });
    await persistRunNow(updated, 'graph maintenance input');
  } else if (['pr-complete', 'update-branch', 'ci-fix'].includes(run.flowType)) {
    if (!latest.steps.some((step) => step.name === PipelineSteps.WRITE_TASK))
      throw new MaintenanceRefusal('MAINTENANCE_STEP_MISSING');
    const steps = latest.steps.map((step) =>
      step.name === PipelineSteps.WRITE_TASK
        ? {
            ...step,
            outputs: {
              ...step.outputs,
              branchMaintenanceOperation: operation,
              branchMaintenanceCompleted: false,
            },
          }
        : step,
    );
    await persistRunNow(updateRun(run.id, { steps }), 'branch maintenance input');
  } else {
    await persistRunNow(
      updateRun(run.id, {
        ciWatchState: {
          ...emptyCiWatchState(),
          ...latest.ciWatchState,
          branchMaintenanceOperation: operation,
        },
      }),
      'inline maintenance input',
    );
  }
  return operation;
}

/** One compare-and-set writer, including archived publication owners. */
export async function completeBranchMaintenance(
  run: Run,
  explicitOperation?: BranchMaintenanceOperation,
  deps: MaintenanceDependencies = defaultDependencies,
): Promise<BranchMaintenanceCheckpoint | undefined> {
  const operation = explicitOperation ?? pendingBranchMaintenance(getRun(run.id) ?? run);
  if (!operation) return undefined;
  if (!run.slotId) throw new Error('Maintenance result has no retained slot.');
  const vars = await deps.loadSlot(run.slotId);
  if (vars.remoteRepo !== operation.repo)
    throw new MaintenanceRefusal('MAINTENANCE_CHECKOUT_CHANGED');
  let verified: { headSha: string; replayBoundarySha: string };
  try {
    verified = await deps.runtime(vars, 'verify', operation);
  } catch (error) {
    if (
      error instanceof MaintenanceRefusal &&
      ['TARGET_CHANGED', 'REMOTE_CHILD_CHANGED', 'REMOTE_RESULT_CHANGED'].includes(error.code)
    )
      await retireBranchMaintenance(run, operation, deps);
    throw error;
  }
  const owner = await getRunWithArchived(operation.ownerRunId);
  if (
    !owner ||
    owner.project !== operation.project ||
    normalizeMaintenanceBranch(owner.branch ?? '') !== operation.branch
  )
    throw new MaintenanceRefusal('MAINTENANCE_OWNER_CHANGED');
  const baseRef = await publicationBaseForRun(owner, operation.baseRef);
  if (normalizeMaintenanceBranch(baseRef) !== operation.baseRef)
    throw new MaintenanceRefusal('MAINTENANCE_BASE_CHANGED');
  const authorityLineage: Array<{
    run: Run;
    parentRunId: Run['parentRunId'];
    stack: Run['stack'];
  }> = [];
  for await (const candidate of contributionLineage(owner)) {
    authorityLineage.push({
      run: candidate,
      parentRunId: candidate.parentRunId,
      stack: structuredClone(candidate.stack),
    });
  }
  const captured = await deps.capture(vars, {
    mode: 'cold',
    baseRef: operation.baseRef,
    committedBaseSha: operation.targetSha,
    committedHeadSha: verified.headSha,
  });
  if (
    captured.snapshot.source === 'unavailable' ||
    captured.snapshot.baseSha !== operation.targetSha ||
    captured.snapshot.headSha !== verified.headSha
  )
    throw new Error('MAINTENANCE_CAPTURE_UNAVAILABLE');
  const next: BranchMaintenanceCheckpoint = {
    ...captured.snapshot,
    headRef: operation.branch,
    replayBoundarySha: verified.replayBoundarySha,
  };
  const sameResult = (checkpoint: BranchMaintenanceCheckpoint | undefined): boolean =>
    !!checkpoint && isDeepStrictEqual({ ...checkpoint, capturedAt: next.capturedAt }, next);
  const committed = await commitRunPublication(
    owner.id,
    (latest) => ({
      prNumber: latest.prNumber!,
      links: latest.links,
      prPublications: latest.prPublications,
      publishGate: {
        ...latest.engineState?.publishGate,
        maintainedSnapshot: sameResult(latest.engineState?.publishGate?.maintainedSnapshot)
          ? latest.engineState!.publishGate!.maintainedSnapshot
          : next,
      },
    }),
    (latest) => {
      for (const authority of authorityLineage) {
        const currentAuthority = getRun(authority.run.id) ?? authority.run;
        if (
          currentAuthority.parentRunId !== authority.parentRunId ||
          !isDeepStrictEqual(currentAuthority.stack, authority.stack)
        )
          throw new MaintenanceRefusal('MAINTENANCE_BASE_CHANGED');
      }
      if (
        latest.project !== operation.project ||
        normalizeMaintenanceBranch(latest.branch ?? '') !== operation.branch ||
        (!isDeepStrictEqual(
          latest.engineState?.publishGate?.maintainedSnapshot,
          operation.expectedCheckpoint,
        ) &&
          !sameResult(latest.engineState?.publishGate?.maintainedSnapshot))
      )
        throw new MaintenanceRefusal('STALE_MAINTENANCE_RENEWAL');
    },
  );
  const latest = getRun(run.id);
  if (latest?.ciWatchState?.branchMaintenanceOperation?.id === operation.id)
    await persistRunNow(
      updateRun(run.id, {
        ciWatchState: {
          ...emptyCiWatchState(),
          ...latest.ciWatchState,
          branchMaintenanceOperation: undefined,
        },
      }),
      'maintenance reconciled',
    );
  const active = getRun(run.id);
  if (
    active?.steps.some(
      (step) =>
        step.name === PipelineSteps.WRITE_TASK &&
        (step.outputs?.branchMaintenanceOperation as BranchMaintenanceOperation | undefined)?.id ===
          operation.id,
    )
  )
    await persistRunNow(
      updateRun(run.id, {
        steps: active.steps.map((step) =>
          step.name === PipelineSteps.WRITE_TASK &&
          (step.outputs?.branchMaintenanceOperation as BranchMaintenanceOperation | undefined)
            ?.id === operation.id
            ? { ...step, outputs: { ...step.outputs, branchMaintenanceCompleted: true } }
            : step,
        ),
      }),
      'maintenance completion',
    );
  return committed.engineState!.publishGate!.maintainedSnapshot;
}
