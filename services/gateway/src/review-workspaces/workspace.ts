import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { NATIVE_WORKER_STATE } from '@farmslot/agent-runtime/native';
import type { ReviewWorkspaceBinding, Run } from '@farmslot/protocol';

import { execFileArgv, isLocal } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { execNativeNodeArgv, routeNativeExecution } from '../runners/native/node.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

import type { ReviewWorkspaceAdmission } from './admission.js';
import { REVIEW_SKILL_INSTALL_SCRIPT } from './skill-install.js';
import { REVIEW_WORKSPACE_SCRIPT } from './workspace-node.js';

export { REVIEW_WORKSPACE_SCRIPT } from './workspace-node.js';

interface WorkspaceOptions {
  assertCurrent: () => void | Promise<void>;
}

interface AllocateOptions extends WorkspaceOptions {
  headSha: string;
  baseSha: string;
  repositoryUrl: string;
}

function ownedRun(runId: string): Run {
  const run = getRun(runId);
  if (
    !run ||
    run.flowType !== 'review-pr' ||
    run.transport !== 'native' ||
    run.slotId !== null ||
    !run.reviewWorkspaceTarget ||
    !run.nativeOwnerPrincipalId
  )
    throw new Error('Review workspace requires an owned native review run without a slot');
  assertNativeRunOwner(run);
  return run;
}

const operations = new Set<string>();

async function exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  if (operations.has(runId))
    throw new GatewayMethodError(
      'REVIEW_WORKSPACE_OPERATION_PENDING',
      'Review workspace operation is still running',
    );
  operations.add(runId);
  try {
    return await operation();
  } finally {
    operations.delete(runId);
  }
}

function identityFor(run: Run, binding: ReviewWorkspaceBinding, subject: AllocateOptions) {
  return {
    runId: run.id,
    workspaceId: binding.workspaceId,
    owner: run.nativeOwnerPrincipalId,
    project: run.project,
    machine: binding.machine,
    executionNodeId: binding.executionNodeId,
    repositoryUrl: subject.repositoryUrl,
    headSha: subject.headSha,
    baseSha: subject.baseSha,
  };
}

async function executeWorkspace(
  run: Run,
  action: 'allocate' | 'cleanup' | 'cancel',
  subject: AllocateOptions,
): Promise<void> {
  const binding = structuredClone(run.reviewWorkspace!);
  const expected = JSON.stringify({
    identity: identityFor(run, binding, subject),
    sourceSubject: run.reviewWorkspaceSubject,
    binding,
    generation: run.engineState?.generation ?? 0,
  });
  const check = async () => {
    await subject.assertCurrent();
    const current = ownedRun(run.id);
    if (
      action === 'cleanup' &&
      current.agentContexts?.some(
        (context) => context.nativeSession && !context.nativeSession.closedAt,
      )
    )
      throw new Error('Confirm native worker process closure before deleting a review checkout');
    if (
      !current.reviewWorkspace ||
      JSON.stringify({
        identity: identityFor(current, current.reviewWorkspace, subject),
        sourceSubject: current.reviewWorkspaceSubject,
        binding: current.reviewWorkspace,
        generation: current.engineState?.generation ?? 0,
      }) !== expected
    )
      throw new Error('Review workspace ownership or generation changed during node operation');
  };
  const root = path.posix.resolve(binding.checkoutPath, '../../..');
  const argv = [
    'node',
    '-e',
    REVIEW_WORKSPACE_SCRIPT,
    JSON.stringify({
      root,
      identity: identityFor(run, binding, subject),
      generation: run.engineState?.generation ?? 0,
      action,
      allowCancelled: action === 'cleanup' && run.status === 'cancelled',
    }),
  ];
  await check();
  const result =
    binding.executionNodeId === 'local'
      ? await execFileArgv([process.execPath, ...argv.slice(1)], { timeout: 300_000 })
      : await execNativeNodeArgv(run.nativeOwnerPrincipalId!, binding.machine, argv, 300_000);
  await check();
  const receipt = result.stdout
    ? (JSON.parse(result.stdout) as { state?: string; error?: { code?: string; message?: string } })
    : undefined;
  if (result.exitCode !== 0)
    throw new GatewayMethodError(
      receipt?.error?.code === 'REVIEW_WORKSPACE_OPERATION_PENDING'
        ? receipt.error.code
        : 'REVIEW_WORKSPACE_ALLOCATION_FAILED',
      receipt?.error?.message || result.stderr || 'Workspace operation failed',
    );
  if (
    receipt?.state !==
    (action === 'allocate' ? 'ready' : action === 'cancel' ? 'cancelled' : 'cleaned')
  )
    throw new Error('Workspace operation returned an invalid receipt');
}

export async function allocateReviewWorkspace(
  runId: string,
  admission: ReviewWorkspaceAdmission,
  options: AllocateOptions,
): Promise<ReviewWorkspaceBinding> {
  return exclusive(runId, async () => {
    await options.assertCurrent();
    const initial = ownedRun(runId);
    const owner = initial.nativeOwnerPrincipalId!;
    if (
      admission.project.name !== initial.project ||
      options.repositoryUrl !== admission.project.repoUrl ||
      admission.pool.machine !== initial.reviewWorkspaceTarget!.machine ||
      admission.executionNodeId !==
        (isLocal(admission.pool.host, admission.pool.machine) ? 'local' : admission.pool.machine)
    )
      throw new Error('Review workspace admission no longer matches the run or repository');
    for (const sha of [options.headSha, options.baseSha])
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
        throw new Error('Review workspace requires full immutable commit SHAs');
    const subject = initial.reviewWorkspaceSubject;
    if (
      !subject ||
      subject.repositoryUrl !== options.repositoryUrl ||
      subject.headSha !== options.headSha ||
      subject.baseSha !== options.baseSha
    )
      throw new Error('Review workspace source does not match its frozen subject');
    const initialGeneration = initial.engineState?.generation ?? 0;
    const initialProject = initial.project;
    const initialSubject = JSON.stringify(subject);
    const originalBinding = initial.reviewWorkspace
      ? structuredClone(initial.reviewWorkspace)
      : undefined;
    const workspaceId = originalBinding?.workspaceId ?? randomUUID();
    const state = (await routeNativeExecution(owner, NATIVE_WORKER_STATE, {
      executionNodeId: admission.executionNodeId,
      sessionId: workspaceId,
    })) as { stateDirectory: string };
    await options.assertCurrent();
    const current = ownedRun(runId);
    if (
      current.nativeOwnerPrincipalId !== owner ||
      current.project !== initialProject ||
      current.reviewWorkspaceTarget?.machine !== admission.pool.machine ||
      (current.engineState?.generation ?? 0) !== initialGeneration ||
      JSON.stringify(current.reviewWorkspaceSubject) !== initialSubject ||
      JSON.stringify(current.reviewWorkspace) !== JSON.stringify(originalBinding)
    )
      throw new Error('Review workspace ownership changed during allocation');
    // Native state layout is <native-root>/workers/<owner-hash>/<session-id>.
    // Workspaces are siblings of native-root so writable output never grants access to profiles.
    const ownerHash = createHash('sha256').update(owner).digest('hex');
    const suffix = `/workers/${ownerHash}/${workspaceId}`;
    if (!state.stateDirectory.startsWith('/') || !state.stateDirectory.endsWith(suffix))
      throw new Error('Node returned an incompatible worker state root');
    const nativeRoot = state.stateDirectory.slice(0, -suffix.length);
    const root = path.posix.join(path.posix.dirname(nativeRoot), 'review-workspaces', ownerHash);
    const workspace = path.posix.join(root, 'runs', workspaceId);
    const binding: ReviewWorkspaceBinding = {
      workspaceId,
      machine: admission.pool.machine,
      executionNodeId: admission.executionNodeId,
      checkoutPath: path.posix.join(workspace, 'source'),
      taskPath: path.posix.join(workspace, 'task'),
      artifactPath: path.posix.join(workspace, 'task', 'artifacts'),
      ...(originalBinding?.support ? { support: originalBinding.support } : {}),
    };
    if (originalBinding && JSON.stringify(originalBinding) !== JSON.stringify(binding))
      throw new Error('Persisted review workspace binding conflicts with node-owned paths');
    updateRun(runId, { reviewWorkspace: binding });
    await persistRunNow(ownedRun(runId), 'review workspace allocation identity');
    await executeWorkspace(ownedRun(runId), 'allocate', options);
    return structuredClone(binding);
  });
}

export async function cleanupReviewWorkspace(
  runId: string,
  options: WorkspaceOptions,
): Promise<void> {
  return exclusive(runId, async () => {
    await options.assertCurrent();
    const run = ownedRun(runId);
    if (!run.reviewWorkspace) return;
    if (
      run.agentContexts?.some((context) => context.nativeSession && !context.nativeSession.closedAt)
    )
      throw new Error('Confirm native worker process closure before deleting a review checkout');
    const subject = run.reviewWorkspaceSubject;
    if (!subject) throw new Error('Review workspace has no frozen source subject');
    await removeReviewWorkspaceSkills(run);
    await options.assertCurrent();
    await executeWorkspace(run, 'cleanup', { ...subject, assertCurrent: options.assertCurrent });
  });
}

/** Durable node-side cancellation also fences an allocation that has not started yet. */
export async function cancelReviewWorkspaceAllocation(
  runId: string,
  options: WorkspaceOptions,
): Promise<void> {
  const run = ownedRun(runId);
  if (!run.reviewWorkspace || !run.reviewWorkspaceSubject) return;
  await executeWorkspace(run, 'cancel', {
    ...run.reviewWorkspaceSubject,
    assertCurrent: options.assertCurrent,
  });
}

/** Remove only verified framework skill links after the reviewer has stopped. */
async function removeReviewWorkspaceSkills(run: Run): Promise<void> {
  const workspace = run.reviewWorkspace;
  if (!workspace?.support) return;
  assertNativeRunOwner(run);
  const argv = [
    'node',
    '-e',
    REVIEW_SKILL_INSTALL_SCRIPT,
    JSON.stringify({
      action: 'cleanup',
      checkout: workspace.checkoutPath,
      skills: workspace.support.skills,
    }),
  ];
  const result =
    workspace.executionNodeId === 'local'
      ? await execFileArgv([process.execPath, ...argv.slice(1)], { timeout: 300000 })
      : await execNativeNodeArgv(run.nativeOwnerPrincipalId!, workspace.machine, argv, 300000);
  if (result.exitCode !== 0) throw new Error(`Review skill cleanup failed: ${result.stderr}`);
}
