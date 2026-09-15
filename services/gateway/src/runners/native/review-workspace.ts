import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STATE,
  type NativeWorkerCancelResult,
  type NativeWorkerLaunch,
} from '@farmslot/agent-runtime/native';
import { nativeRunnerDefinitions } from '@farmslot/agent-runtime/native/registry';
import {
  nativeWorkerLaunchDigest,
  validateNativeWorkerFilesystemPolicy,
} from '@farmslot/agent-runtime/native/worker-launch';
import {
  type AgentContext,
  isTerminalRunStatus,
  nativeProfileSessionParams,
  type NativeSessionInfo,
  type NativeSessionReadResult,
  type NativeWorkerSessionBinding,
  type Run,
} from '@farmslot/protocol';

import { upsertAgentContext } from '../../agents/contexts.js';
import type { RawProjectJson } from '../../core/config.js';
import { resolveProjectCommandEnv } from '../../core/project-env.js';
import { isNodeTransportUnavailableError } from '../../fleet/node-rpc.js';
import { getRun, persistRunNow, updateRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';
import { resolveRunnerEffort, taskRecipeTrustEnvironment } from '../launch-command.js';
import { runnerSupportsEffort } from '../registry.js';

import { validateNativeRunner } from './manager.js';
import { routeNativeExecution } from './node.js';
import { assertNativeWorkerSnapshot } from './worker-control.js';
import { NativeWorkerOperationUncertainError } from './worker-error.js';
import { inspectNativeWorkerProfile } from './worker-profile.js';

const CONTEXT_ID = 'review';

function reviewReadOnlyRoots(workspace: NonNullable<Run['reviewWorkspace']>): string[] {
  return [workspace.checkoutPath, ...(workspace.support ? [workspace.support.path] : [])];
}

/** Retry only a lost transport, keeping the same session, lease and command identities. */
async function observeTransport<T>(
  operation: () => Promise<T>,
  assertCurrent: () => void,
  deadline: number,
  kind: NativeWorkerOperationUncertainError['operation'],
): Promise<T> {
  for (;;) {
    assertCurrent();
    try {
      return await operation();
    } catch (error) {
      if (!isNodeTransportUnavailableError(error)) throw error;
      assertCurrent();
      if (Date.now() >= deadline)
        throw new NativeWorkerOperationUncertainError(
          kind,
          'Native reviewer observation is unavailable; its owned reservation is retained for reconciliation.',
          error,
        );
      await delay(Math.min(1000, deadline - Date.now()));
    }
  }
}

export function runnerSupportsReadonlyReviewWorkspace(runner: string): boolean {
  return nativeRunnerDefinitions[runner]?.supportsReadOnlyWorkspace === true;
}

export function assertReviewWorkspaceRun(run: Run | null | undefined): asserts run is Run & {
  reviewWorkspace: NonNullable<Run['reviewWorkspace']>;
  nativeOwnerPrincipalId: string;
} {
  if (
    !run ||
    run.flowType !== 'review-pr' ||
    run.slotId !== null ||
    run.transport !== 'native' ||
    !run.reviewWorkspace ||
    !run.nativeOwnerPrincipalId
  )
    throw new Error('Static native review requires an owned workspace run without a slot');
  const workspace = run.reviewWorkspace;
  if (run.reviewWorkspaceTarget?.machine !== workspace.machine)
    throw new Error('Static review workspace placement changed');
  validateNativeWorkerFilesystemPolicy({
    readOnlyRoots: reviewReadOnlyRoots(workspace),
    writableRoots: [workspace.taskPath, workspace.artifactPath],
  });
  if (
    run.nativeProfile &&
    (run.nativeProfile.executionNodeId !== workspace.executionNodeId ||
      run.nativeProfile.runner !== run.metrics.runner)
  )
    throw new Error('Static review native profile belongs to another runner or node');
}

function ownedRun(runId: string) {
  const run = getRun(runId);
  assertReviewWorkspaceRun(run);
  assertNativeRunOwner(run);
  return run;
}

function contextFor(run: Run) {
  return run.agentContexts?.find((context) => context.id === CONTEXT_ID);
}

function executionFence(run: Run, allowTerminal = false): () => void {
  const generation = run.engineState?.generation ?? 0;
  const workspace = JSON.stringify(run.reviewWorkspace);
  return () => {
    const current = ownedRun(run.id);
    if (
      (current.engineState?.generation ?? 0) !== generation ||
      JSON.stringify(current.reviewWorkspace) !== workspace ||
      (!allowTerminal &&
        (current.reviewWorkspace.cleanedAt ||
          isTerminalRunStatus(current.status) ||
          ['paused', 'blocked'].includes(current.status)))
    )
      throw new Error('Static review workspace is no longer admitted for input');
  };
}

function currentBinding(run: Run): NativeWorkerSessionBinding {
  const binding = contextFor(run)?.nativeSession;
  if (
    !binding ||
    binding.releasedAt ||
    binding.ownerPrincipalId !== run.nativeOwnerPrincipalId ||
    binding.executionNodeId !== run.reviewWorkspace?.executionNodeId
  )
    throw new Error('Static review no longer owns its native worker binding');
  return binding;
}

function target(binding: NativeWorkerSessionBinding) {
  return {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    leaseId: binding.leaseId,
  };
}

async function saveContext(
  runId: string,
  patch: Partial<AgentContext>,
  expected?: NativeWorkerSessionBinding,
  assertCurrent = executionFence(ownedRun(runId)),
) {
  const saved = await upsertAgentContext(
    runId,
    'review',
    { id: CONTEXT_ID },
    {
      resolvePatch: (existing) => {
        assertCurrent();
        if (
          expected &&
          (existing?.nativeSession?.sessionId !== expected.sessionId ||
            existing.nativeSession.leaseId !== expected.leaseId ||
            existing.nativeSession.generation !== expected.generation ||
            existing.nativeSession.closedAt ||
            existing.nativeSession.releasedAt)
        )
          throw new Error('Static review worker changed before persistence');
        if (!expected && existing?.nativeSession)
          throw new Error('Static review already reserved its worker');
        return patch;
      },
    },
  );
  if (!saved) throw new Error('Static review context could not be persisted');
  await persistRunNow(ownedRun(runId), 'static review native worker');
  return saved;
}

export async function launchReviewWorkspaceWorker(input: {
  runId: string;
  project: RawProjectJson;
  domain?: string;
  machineEnv?: Record<string, string>;
  executable?: string;
  prompt: string;
  deadline: number;
  assertCurrent: () => void | Promise<void>;
}): Promise<NativeSessionReadResult> {
  const original = ownedRun(input.runId);
  const workspace = structuredClone(original.reviewWorkspace);
  const assertCurrent = executionFence(original);
  const check = async () => {
    await observeTransport(
      async () => input.assertCurrent(),
      assertCurrent,
      input.deadline,
      'launch',
    );
    assertCurrent();
    return ownedRun(input.runId);
  };
  const run = await check();
  const route = (owner: string, method: string, params: Record<string, unknown>) =>
    observeTransport(
      () => routeNativeExecution(owner, method, params),
      assertCurrent,
      input.deadline,
      method === NATIVE_WORKER_SEND ? 'delivery' : 'launch',
    );
  const runner = run.metrics.runner;
  const model = run.metrics.model;
  if (!runner || !model || !runnerSupportsReadonlyReviewWorkspace(runner))
    throw new Error('Selected runner cannot enforce read-only source review');
  validateNativeRunner(runner, model);
  const effort = resolveRunnerEffort(runner, run.effort);
  if (!runnerSupportsEffort(runner, model, effort))
    throw new Error('Selected static review runner/model does not support this effort');
  if (run.nativeProfile)
    await observeTransport(
      () => inspectNativeWorkerProfile(run.nativeOwnerPrincipalId, run.nativeProfile!),
      assertCurrent,
      input.deadline,
      'launch',
    );
  await check();
  let context = contextFor(ownedRun(run.id));
  if (!context?.nativeSession) {
    context = await saveContext(
      run.id,
      {
        status: 'launching',
        runner,
        model,
        taskFile: path.posix.join(workspace.taskPath, 'TASK.md'),
        signalFile: path.posix.join(workspace.taskPath, 'SIGNAL.json'),
        artifactScope: workspace.artifactPath,
        nativeCommandText: input.prompt,
        nativeSession: {
          sessionId: randomUUID(),
          leaseId: randomUUID(),
          commandId: randomUUID(),
          executionNodeId: workspace.executionNodeId,
          ownerPrincipalId: run.nativeOwnerPrincipalId,
          profile: run.nativeProfile,
          safetyTier: 'sandboxed',
          effort,
        },
      },
      undefined,
      assertCurrent,
    );
  }
  await check();
  let binding = structuredClone(currentBinding(ownedRun(run.id)));
  if (binding.closedAt || binding.recovery || context.nativeCommandText !== input.prompt)
    throw new Error('Static review requires explicit recovery or its original materialized prompt');
  if (!binding.stateDirectory) {
    const state = (await route(binding.ownerPrincipalId, NATIVE_WORKER_STATE, target(binding))) as {
      stateDirectory: string;
    };
    await check();
    validateNativeWorkerFilesystemPolicy({
      readOnlyRoots: reviewReadOnlyRoots(workspace),
      writableRoots: [state.stateDirectory],
    });
    context = await saveContext(
      run.id,
      { nativeSession: { ...binding, stateDirectory: state.stateDirectory } },
      binding,
      assertCurrent,
    );
    binding = structuredClone(context.nativeSession!);
  }
  const supportSettings = workspace.support
    ? Object.fromEntries(
        Object.entries(workspace.support.environment).map(([name, value]) => [
          name,
          value.replaceAll('{{support}}', workspace.support!.path),
        ]),
      )
    : undefined;
  const environment = resolveProjectCommandEnv(input.project, {
    domain: input.domain,
    overrides: supportSettings,
  });
  environment.set = { ...environment.set, ...input.machineEnv };
  environment.unset = environment.unset.filter(
    (name) => !Object.hasOwn(input.machineEnv ?? {}, name),
  );
  const trust = taskRecipeTrustEnvironment(false);
  for (const name of trust.unset) delete environment.set[name];
  environment.set = { ...environment.set, ...trust.set };
  environment.unset = [...new Set([...environment.unset, ...trust.unset])];
  if (workspace.support) {
    const support = workspace.support;
    const settings = supportSettings!;
    // The task names the frozen runtime by its absolute path. Do not replace the
    // execution node's PATH with the gateway host's environment.
    delete environment.set.NODE_OPTIONS;
    delete environment.set.NODE_PATH;
    environment.set = { ...environment.set, ...settings, GIT_CEILING_DIRECTORIES: support.path };
    environment.unset = [
      ...new Set([
        ...environment.unset.filter(
          (name) => !Object.hasOwn(settings, name) && name !== 'GIT_CEILING_DIRECTORIES',
        ),
        'NODE_OPTIONS',
        'NODE_PATH',
      ]),
    ];
  }
  const launch: NativeWorkerLaunch = {
    leaseId: binding.leaseId,
    executable: input.executable ?? nativeRunnerDefinitions[runner].binary,
    environment,
    safetyTier: 'sandboxed',
    effort,
    filesystemPolicy: {
      readOnlyRoots: reviewReadOnlyRoots(workspace),
      writableRoots: [workspace.taskPath, workspace.artifactPath],
    },
  };
  const digest = nativeWorkerLaunchDigest(launch);
  if (binding.launchDigest && binding.launchDigest !== digest)
    throw new Error('Static review launch configuration changed during retry');
  context = await saveContext(
    run.id,
    {
      nativeSession: {
        ...binding,
        launchDigest: digest,
        launchRequestedAt: binding.launchRequestedAt ?? new Date().toISOString(),
      },
    },
    binding,
    assertCurrent,
  );
  binding = structuredClone(context.nativeSession!);
  await check();
  const created = (await route(binding.ownerPrincipalId, NATIVE_WORKER_ENSURE, {
    ...target(binding),
    ...nativeProfileSessionParams(binding.profile),
    runner,
    model,
    cwd: workspace.checkoutPath,
    launch,
  })) as { session: NativeSessionInfo };
  assertNativeWorkerSnapshot({ ...binding, generation: created.session.generation }, {
    session: created.session,
  } as NativeSessionReadResult);
  if (binding.generation && binding.generation !== created.session.generation)
    throw new Error('Static review worker generation changed during creation');
  if (
    created.session.cwd !== workspace.checkoutPath ||
    ['closed', 'failed'].includes(created.session.state)
  )
    throw new Error('Static review reservation is terminal or belongs to another workspace');
  context = await saveContext(
    run.id,
    {
      runnerSessionId: created.session.nativeSessionId,
      nativeSession: { ...binding, generation: created.session.generation },
    },
    binding,
    assertCurrent,
  );
  binding = structuredClone(context.nativeSession!);
  await check();
  const snapshot = await readReviewWorkspaceWorker(run.id, { deadline: input.deadline });
  const receipt = snapshot.commands.find((command) => command.commandId === binding.commandId);
  if (!receipt) {
    await check();
    await route(binding.ownerPrincipalId, NATIVE_WORKER_SEND, {
      ...target(binding),
      generation: binding.generation,
      commandId: binding.commandId,
      text: input.prompt,
    });
  }
  return readReviewWorkspaceWorker(run.id, { deadline: input.deadline });
}

export async function readReviewWorkspaceWorker(
  runId: string,
  options: { after?: number; limit?: number; deadline?: number } = {},
): Promise<NativeSessionReadResult> {
  const original = ownedRun(runId);
  const assertCurrent = executionFence(original);
  const binding = structuredClone(currentBinding(original));
  if (!binding.generation) throw new Error('Static review worker creation is not yet confirmed');
  const { deadline = Date.now(), ...readOptions } = options;
  const snapshot = (await observeTransport(
    () =>
      routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_READ, {
        ...target(binding),
        ...readOptions,
      }),
    assertCurrent,
    deadline,
    'observation',
  )) as NativeSessionReadResult;
  assertNativeWorkerSnapshot(binding, snapshot);
  assertNativeWorkerSnapshot(currentBinding(ownedRun(runId)), snapshot);
  const command = snapshot.commands.find((receipt) => receipt.commandId === binding.commandId);
  if (command?.accepted && !binding.acceptedAt && !binding.closedAt) {
    await saveContext(
      runId,
      { status: 'working', nativeSession: { ...binding, acceptedAt: new Date().toISOString() } },
      binding,
      assertCurrent,
    );
  }
  // Repair a crash between the acceptance checkpoint and the metrics checkpoint.
  if (command?.accepted && !binding.closedAt) {
    assertCurrent();
    const run = ownedRun(runId);
    if (run.metrics.runnerSessionId !== snapshot.session.nativeSessionId) {
      await persistRunNow(
        updateRun(runId, {
          metrics: {
            ...run.metrics,
            runnerSessionId: snapshot.session.nativeSessionId,
            runnerSessionPath: null,
          },
        }),
        'workspace reviewer session identity',
      );
    }
  }
  return snapshot;
}

export function assertReviewWorkspaceCancellation(
  binding: NativeWorkerSessionBinding,
  result: NativeWorkerCancelResult,
): void {
  if (
    !result.cancelled ||
    result.sessionId !== binding.sessionId ||
    result.leaseId !== binding.leaseId ||
    (binding.generation && result.generation !== binding.generation)
  )
    throw new Error('Static review worker cancellation is unconfirmed');
  if (binding.generation && !result.session)
    throw new Error('Static review worker process cleanup requires its current session');
  if (result.session) {
    assertNativeWorkerSnapshot(
      { ...binding, generation: binding.generation ?? result.session.generation },
      { session: result.session } as NativeSessionReadResult,
    );
    if (
      !['closed', 'failed'].includes(result.session.state) ||
      (result.session.processPid && !result.session.processStopped)
    )
      throw new Error('Static review worker process cleanup is unconfirmed');
  }
}

export async function cancelReviewWorkspaceWorker(runId: string): Promise<void> {
  const run = ownedRun(runId);
  if (!contextFor(run)?.nativeSession) return;
  const binding = structuredClone(currentBinding(run));
  if (binding.closedAt) return;
  // Persist a host tombstone even before ensure arrives, fencing a delayed launch.
  const result = (await routeNativeExecution(binding.ownerPrincipalId, NATIVE_WORKER_CANCEL, {
    ...target(binding),
    generation: binding.generation,
  })) as NativeWorkerCancelResult;
  assertReviewWorkspaceCancellation(binding, result);
  await saveContext(
    runId,
    { status: 'idle', nativeSession: { ...binding, closedAt: new Date().toISOString() } },
    binding,
    executionFence(run, true),
  );
}
