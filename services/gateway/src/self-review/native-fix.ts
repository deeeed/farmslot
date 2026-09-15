import { randomUUID } from 'node:crypto';

import { isTerminalRunStatus } from '@farmslot/protocol';

import { selectAgentContext, upsertAgentContext } from '../agents/contexts.js';
import { resolveNativeContext } from '../agents/native-context.js';
import {
  readNativeWorkerSnapshot,
  sendNativeWorkerInstruction,
} from '../runners/native/worker-control.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { watchContext } from '../tasks/watcher.js';

import { assertNativeReviewOperationCurrent } from './native-review-operation.js';

export async function prepareNativeFix(input: {
  runId: string;
  taskFile: string;
  signalFile: string;
  attemptStartedAt: string;
  prompt: string;
  fixBaseSha: string | null;
  artifactScope?: string | null;
}) {
  assertNativeReviewOperationCurrent();
  const run = getRun(input.runId);
  const primary = run && selectAgentContext(run, { role: 'primary' });
  const binding = primary?.nativeSession;
  if (
    !run ||
    !run.slotId ||
    run.transport !== 'native' ||
    !primary ||
    !binding?.acceptedAt ||
    binding.closedAt ||
    binding.releasedAt ||
    isTerminalRunStatus(run.status)
  )
    throw new Error('Native fix requires the current accepted worker lease');
  const generation = run.engineState?.generation;
  const commandId = randomUUID();
  const context = await upsertAgentContext(
    run.id,
    'self-review-fix',
    {
      status: 'working',
      attemptStartedAt: input.attemptStartedAt,
      artifactScope: input.artifactScope,
      signalAttemptId: undefined,
      promptDeliveryStartedAt: undefined,
      deliveryBaselineRef: input.fixBaseSha ?? undefined,
      taskFile: input.taskFile,
      signalFile: input.signalFile,
      runner: primary.runner,
      model: primary.model,
      runnerSessionId: primary.runnerSessionId,
      target: null,
      nativeSessionOwner: {
        contextId: primary.id,
        sessionId: binding.sessionId,
        leaseId: binding.leaseId,
      },
      nativeCommandId: commandId,
      nativeCommandText: input.prompt,
    },
    {
      guard: async () => {
        assertNativeReviewOperationCurrent();
        const current = getRun(run.id);
        if (
          !current ||
          isTerminalRunStatus(current.status) ||
          current.engineState?.generation !== generation
        )
          throw new Error('Native fix generation changed');
        return true;
      },
      mirrorIf: (slot) => slot.current_run_id === run.id,
    },
  );
  if (!context?.slotId) throw new Error('Native fix context has no owned slot');
  assertNativeReviewOperationCurrent();
  await persistRunNow(
    updateRun(run.id, { activeTaskFile: input.taskFile }),
    'native fix instruction',
  );
  await watchContext(context.slotId, context);
  return context;
}

export async function deliverNativeFix(
  runId: string,
  contextId: string,
): Promise<
  { status: 'delivered'; turnToken: string } | { status: 'deferred' | 'relaunch-required' }
> {
  assertNativeReviewOperationCurrent();
  const run = getRun(runId);
  const context = run && selectAgentContext(run, { contextId });
  const resolved = run && resolveNativeContext(run, context);
  if (
    !run ||
    !context ||
    !context.slotId ||
    context.role !== 'self-review-fix' ||
    !resolved ||
    !context.nativeCommandId ||
    !context.nativeCommandText
  )
    throw new Error('Native fix instruction or worker lease is unavailable');
  const snapshot = await readNativeWorkerSnapshot(runId, undefined, contextId);
  const receipt = snapshot.commands.find((item) => item.commandId === context.nativeCommandId);
  if (snapshot.session.processStopped) return { status: 'relaunch-required' };
  if (receipt?.accepted) return { status: 'delivered', turnToken: context.nativeCommandId };
  if (receipt?.state === 'failed') return { status: 'deferred' };
  await upsertAgentContext(
    runId,
    context.role,
    { id: contextId },
    {
      mirrorIf: (slot) => slot.current_run_id === runId,
      resolvePatch: (current) => {
        assertNativeReviewOperationCurrent();
        if (!current || current.nativeCommandId !== context.nativeCommandId)
          throw new Error('Native fix attempt changed before delivery');
        return {
          promptDeliveryStartedAt: current.promptDeliveryStartedAt ?? new Date().toISOString(),
        };
      },
    },
  );
  await persistRunNow(getRun(runId)!, 'native fix delivery boundary');
  const result = await sendNativeWorkerInstruction({
    runId,
    slotId: context.slotId,
    contextId,
    key: context.nativeCommandId,
    commandId: context.nativeCommandId,
    text: context.nativeCommandText,
    allowOperatorWait: true,
    assertCurrent: assertNativeReviewOperationCurrent,
  });
  return result === 'confirmed'
    ? { status: 'delivered', turnToken: context.nativeCommandId }
    : { status: 'deferred' };
}

export async function nativeFixTurnIsActive(
  runId: string,
  expectedCommand: string,
): Promise<boolean> {
  assertNativeReviewOperationCurrent();
  const run = getRun(runId);
  const context = run && selectAgentContext(run, { role: 'self-review-fix' });
  if (!context || context.status !== 'working' || context.nativeCommandId !== expectedCommand)
    return false;
  const snapshot = await readNativeWorkerSnapshot(runId, undefined, context.id);
  const receipt = snapshot.commands.find((item) => item.commandId === expectedCommand);
  return Boolean(
    receipt?.accepted &&
    receipt.generation === snapshot.session.generation &&
    !receipt.outcome &&
    !snapshot.session.processStopped,
  );
}
