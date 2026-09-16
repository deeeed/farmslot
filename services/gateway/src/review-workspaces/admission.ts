import {
  type NativeProfileReference,
  type PoolConfig,
  type PressureAdmissionDecision,
  type ProjectConfig,
  type Run,
  type WorkerTransport,
} from '@farmslot/protocol';

import { isLocal } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { loadPoolConfigs, loadProjectConfig } from '../fleet/state.js';
import { capturePressureAdmissionDecisionsLightweight } from '../methods/dispatch/pressure-admission.js';
import { resolveNativeExecutionNode } from '../runners/native/node.js';
import { runnerSupportsReadonlyReviewWorkspace } from '../runners/native/review-workspace.js';
import {
  isKnownRunner,
  runnerSupportsEffort,
  runnerSupportsModel,
  runnerSupportsNativeTaskReuse,
} from '../runners/registry.js';
import { getAllRuns } from '../runs/store.js';
import { ownsLocalNativeProfile } from '../security/native-owner.js';

export interface ReviewWorkspaceAdmissionInput {
  project: string;
  machine: string;
  runner: string;
  model: string;
  effort?: string;
  transport?: WorkerTransport;
  nativeProfile?: NativeProfileReference;
}

export interface ReviewWorkspaceAdmission {
  pool: PoolConfig;
  project: ProjectConfig;
  executionNodeId: string;
  active: number;
  limit: number;
  pressure: PressureAdmissionDecision;
}

/** A stopped run still owns capacity while an owned reviewer process remains alive. */
export function activeWorkspaceReviews(
  machine: string,
  runs: readonly Run[],
  excludingRunId?: string,
): number {
  return runs.filter((run) => {
    if (run.id === excludingRunId || run.reviewWorkspaceTarget?.machine !== machine) return false;
    const terminal = ['done', 'failed', 'cancelled', 'blocked'].includes(run.status);
    const nativeActive = run.agentContexts?.some(
      (context) =>
        context.nativeSession &&
        !context.nativeSession.closedAt &&
        !context.nativeSession.releasedAt,
    );
    return (
      !terminal ||
      Boolean(nativeActive) ||
      Boolean(run.reviewWorkspace && !run.reviewWorkspace.cleanedAt)
    );
  }).length;
}

export function assertReviewWorkspaceCapacity(
  machine: string,
  limit: number,
  excludingRunId?: string,
): void {
  if (activeWorkspaceReviews(machine, getAllRuns(), excludingRunId) >= limit) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_CAPACITY',
      `Review capacity is full on ${machine}`,
    );
  }
}

/** No device/slot reads: eligibility comes from machine opt-in, project, owner and runner. */
export async function inspectReviewWorkspaceTarget(
  input: ReviewWorkspaceAdmissionInput,
  owner: string,
  excludingRunId?: string,
): Promise<ReviewWorkspaceAdmission> {
  const [pools, project] = await Promise.all([loadPoolConfigs(), loadProjectConfig(input.project)]);
  const matches = pools.filter((pool) => pool.machine === input.machine);
  if (matches.length !== 1) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      'Review machine must resolve to exactly one pool configuration',
    );
  }
  const pool = matches[0];
  if (!pool.reviewWorkspaces) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      `Machine ${pool.machine} has no review workspace capacity configured`,
    );
  }
  if (!project?.repoUrl || !project.staticReview?.templateId || !project.executionTemplates) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      'Configure the project repository and canonical static-review template',
    );
  }
  if (
    pool.project !== input.project &&
    !pool.slots.some((slot) => slot.project === input.project)
  ) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      'Review machine is not configured for this project',
    );
  }
  if (
    !['native', 'tmux'].includes(input.transport ?? '') ||
    (input.transport === 'native' && !runnerSupportsNativeTaskReuse(input.runner)) ||
    !runnerSupportsReadonlyReviewWorkspace(input.runner)
  ) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_UNSUPPORTED',
      'Selected runner and transport do not support managed workspace review',
    );
  }
  if (
    !isKnownRunner(input.runner) ||
    !input.model ||
    input.model === 'unknown' ||
    !runnerSupportsModel(input.runner, input.model) ||
    !runnerSupportsEffort(input.runner, input.model, input.effort)
  ) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_UNSUPPORTED',
      'Selected runner/model/effort is unsupported',
    );
  }
  const executionNodeId = isLocal(pool.host, pool.machine) ? 'local' : pool.machine;
  if (executionNodeId === 'local') {
    if (!ownsLocalNativeProfile(owner))
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Reviewer does not own this local execution node',
      );
  } else {
    const node = resolveNativeExecutionNode(owner, pool.machine);
    if (!node.nativeSessions.supportsWorkers || !node.nativeSessions.supportsEnsure) {
      throw new GatewayMethodError(
        'REVIEW_WORKSPACE_UNSUPPORTED',
        'Review execution node needs managed worker support',
      );
    }
  }
  if (
    input.nativeProfile &&
    (input.nativeProfile.executionNodeId !== executionNodeId ||
      input.nativeProfile.runner !== input.runner)
  ) {
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native profile does not match the review node and runner',
    );
  }
  const pressure = capturePressureAdmissionDecisionsLightweight([pool.machine]).get(pool.machine);
  if (!pressure) throw new Error(`Missing pressure admission result for ${pool.machine}`);
  return {
    pool,
    project,
    executionNodeId,
    pressure,
    active: activeWorkspaceReviews(pool.machine, getAllRuns(), excludingRunId),
    limit: pool.reviewWorkspaces.maxConcurrent,
  };
}

export function assertReviewWorkspaceAdmitted(
  admission: ReviewWorkspaceAdmission,
  excludingRunId?: string,
): void {
  if (admission.pressure.outcome === 'rejected') {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_PRESSURE',
      `Host pressure prevents a new review on ${admission.pool.machine}`,
      { details: admission.pressure },
    );
  }
  assertReviewWorkspaceCapacity(admission.pool.machine, admission.limit, excludingRunId);
}

export function assertReviewWorkspacePlacement(input: {
  flowType: string;
  reviewValidationDepth?: import('@farmslot/protocol').ReviewValidationDepth;
  reviewWorkspaceTarget?: { machine: string };
  slotId?: string | null;
  allowedSlots?: string[] | null;
}): void {
  const target = input.reviewWorkspaceTarget;
  if (!target) {
    if (input.flowType === 'review-pr' && input.reviewValidationDepth !== 'full-live') {
      throw new GatewayMethodError(
        'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
        'Select an authorized review machine; static Review no longer reserves a device slot',
      );
    }
    return;
  }
  if (
    input.flowType !== 'review-pr' ||
    input.reviewValidationDepth === 'full-live' ||
    input.slotId ||
    input.allowedSlots?.length
  ) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      'Workspace Review requires a machine target without slot placement constraints',
    );
  }
  if (
    typeof target.machine !== 'string' ||
    !target.machine.trim() ||
    target.machine !== target.machine.trim() ||
    Object.keys(target).some((key) => key !== 'machine')
  ) {
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
      'Invalid review workspace target',
    );
  }
}
