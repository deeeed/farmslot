import { PipelineSteps, primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { readSlotField } from '../core/state.js';
import { continuePRCompletionStep } from '../methods/run/replay-step.js';
import { probeWorkerSignalForRun } from '../run-engine/run-monitor.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { completionSendBackCommandId } from '../runners/native/worker-control.js';
import { deliverOperatorInstructionWithIntent } from '../runners/operator-instruction-intent.js';
import { getRun, persistRunNow, updateRunStep } from '../runs/store.js';
import {
  normalizeWorkerSignal,
  parseStrictIsoMs,
  signalNewerThanRecorded,
} from '../tasks/worker-signals.js';

interface CompletionDelivery {
  key: string;
  text: string;
  slotId: string;
  contextId: string;
  confirmed: boolean;
  startedAt?: number;
  note?: string;
}

function savedDelivery(run: Run): CompletionDelivery | undefined {
  const value = run.steps.find((step) => step.name === PipelineSteps.DISPATCH)?.outputs
    ?.completionSendBackDelivery;
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !('key' in value) ||
    typeof value.key !== 'string' ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    !('slotId' in value) ||
    typeof value.slotId !== 'string' ||
    !('contextId' in value) ||
    typeof value.contextId !== 'string' ||
    !('confirmed' in value) ||
    typeof value.confirmed !== 'boolean' ||
    ('startedAt' in value &&
      value.startedAt !== undefined &&
      (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt))) ||
    ('note' in value && value.note !== undefined && typeof value.note !== 'string')
  )
    throw new Error('The retained completion feedback intent is invalid');
  return {
    key: value.key,
    text: value.text,
    slotId: value.slotId,
    contextId: value.contextId,
    confirmed: value.confirmed,
    ...('startedAt' in value && typeof value.startedAt === 'number'
      ? { startedAt: value.startedAt }
      : {}),
    ...('note' in value && typeof value.note === 'string' ? { note: value.note } : {}),
  };
}

/** Deliver the refusal once, then resume the retained monitor on a new signal. */
export async function sendBackCompletion(
  run: Run,
  decisionId: string,
  feedback: string,
  emit: (event: string, payload: unknown) => void,
  note?: string,
): Promise<void> {
  const slotId = run.slotId;
  const generation = run.engineState?.generation ?? 0;
  const context = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  if (
    !slotId ||
    !context ||
    !run.steps.some((step) => step.name === PipelineSteps.MONITOR) ||
    !run.steps.some((step) => step.name === PipelineSteps.DISPATCH)
  )
    throw new Error('Send back requires the retained worker and its monitor. Restore it first.');
  const currentRun = () => {
    const current = getRun(run.id);
    if (
      !current ||
      current.readOnly ||
      current.status !== 'needs-decision' ||
      current.slotId !== slotId ||
      (current.engineState?.generation ?? 0) !== generation ||
      selectAgentContext(current, { role: primaryRoleForFlow(current.flowType) })?.id !== context.id
    )
      throw new Error('Completion send-back lost its retained worker or run generation');
    return current;
  };
  const assertOwner = async () => {
    currentRun();
    if ((await readSlotField(slotId, 'current_run_id')) !== run.id)
      throw new Error('Completion send-back no longer owns its slot');
    return currentRun();
  };
  const initial = await assertOwner();
  const dispatch = initial.steps.find((step) => step.name === PipelineSteps.DISPATCH)!;
  const recorded = normalizeWorkerSignal(dispatch.outputs?.completionSendBackSignal);
  const monitor = initial.steps.find((step) => step.name === PipelineSteps.MONITOR)!;
  const consumed = normalizeWorkerSignal(monitor.outputs?.workerSignal);
  let delivery = savedDelivery(initial);
  // A later completed monitor ends this feedback operation. A retry or restart
  // before that point keeps its exact instruction and original signal floor.
  if (
    delivery?.confirmed &&
    recorded.ok &&
    monitor.status === 'done' &&
    consumed.ok &&
    signalNewerThanRecorded(recorded.signal, consumed.signal)
  )
    delivery = undefined;
  if (delivery && (delivery.slotId !== slotId || delivery.contextId !== context.id || !recorded.ok))
    throw new Error('The retained completion feedback belongs to another worker');
  if (delivery && note !== undefined && note !== delivery.note)
    throw new Error('Reconcile the retained completion feedback before changing its operator note');
  const probe = await probeWorkerSignalForRun(run.id, slotId, context);
  const resumingStale =
    delivery &&
    recorded.ok &&
    probe.code === 'stale' &&
    probe.signal?.timestamp === recorded.signal.timestamp &&
    probe.signal.attemptId === recorded.signal.attemptId;
  if (
    (!probe.ok &&
      probe.code !== 'artifact_contract' &&
      probe.code !== 'non_terminal' &&
      !resumingStale) ||
    !probe.signal ||
    parseStrictIsoMs(probe.signal.timestamp) === null
  )
    throw new Error(`Cannot establish the worker signal before send-back: ${probe.message}`);
  const baseline = delivery && recorded.ok ? recorded.signal : probe.signal;
  delivery ??= {
    key: completionSendBackCommandId(decisionId),
    slotId,
    contextId: context.id,
    confirmed: false,
    ...(note ? { note } : {}),
    text: [
      'Completion was refused. Fix the following problem in this task:',
      feedback,
      ...(note ? [`Operator feedback: ${note}`] : []),
      `Keep the existing task and evidence ownership rules. When fixed, use the primary task marking command to write a new terminal signal at ${context.signalFile ?? 'the primary SIGNAL.json'}. The previous completion signal will not be reused.`,
    ].join('\n\n'),
  };
  const persistDelivery = (next: CompletionDelivery, reason: string, clearStartedAt?: number) =>
    withRunTransition(run.id, async () => {
      const latest = await assertOwner();
      const step = latest.steps.find((entry) => entry.name === PipelineSteps.DISPATCH)!;
      const previousOutputs = step.outputs;
      if (clearStartedAt !== undefined) {
        const saved = savedDelivery(latest);
        if (!saved || saved.key !== next.key || saved.startedAt !== clearStartedAt) return;
        const { startedAt: _startedAt, ...untouched } = saved;
        next = untouched;
      }
      updateRunStep(run.id, PipelineSteps.DISPATCH, {
        outputs: {
          ...previousOutputs,
          completionSendBackSignal: baseline,
          completionSendBackDelivery: next,
        },
      });
      try {
        await persistRunNow(getRun(run.id)!, reason);
      } catch (error) {
        updateRunStep(run.id, PipelineSteps.DISPATCH, { outputs: previousOutputs });
        throw error;
      }
    });
  if (!delivery.confirmed) {
    const intent = delivery;
    const result = await deliverOperatorInstructionWithIntent(
      assertOwner,
      { key: intent.key, text: intent.text, contextId: context.id, commandId: intent.key },
      {
        recordPending: async (begin) => {
          const window = begin(intent.startedAt);
          const { startedAt } = window;
          await persistDelivery({ ...intent, startedAt }, 'completion send-back signal baseline');
          return window;
        },
        clearPending: (startedAt) =>
          persistDelivery(intent, 'untouched completion feedback can retry', startedAt),
      },
    );
    if (result.delivery !== 'confirmed')
      throw new Error(`Completion feedback delivery is ${result.delivery}; the run remains held.`);
    delivery = { ...intent, startedAt: result.startedAt, confirmed: true };
    await persistDelivery(delivery, 'completion feedback delivered');
  }
  const key = delivery.key;
  await continuePRCompletionStep(run.id, 'monitor', emit, async () => {
    const latest = await assertOwner();
    const saved = savedDelivery(latest);
    if (!saved?.confirmed || saved.key !== key)
      throw new Error('Completion feedback changed before monitor continuation');
    return true;
  });
}
