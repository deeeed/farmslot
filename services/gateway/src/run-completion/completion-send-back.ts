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
  // A changed note used to be refused for any retained delivery, which left run
  // 09501e29 with no move at all: its feedback was typed into the pane
  // (`startedAt` set) but never confirmed, the worker never wrote a new signal,
  // and its card was answered another way — so the instruction could neither be
  // retried (its card is gone) nor replaced (this refusal). Every later
  // send-back that worded its feedback differently was refused, permanently.
  //
  // What replacing has to answer for is the worker seeing two versions of the
  // same feedback: `recordPending` writes `startedAt` before the transport call
  // and only a `not-attempted` outcome clears it, so a delivery carrying one was
  // typed into a composer or durably queued, and its text can still arrive.
  //
  // So the replacement says so in band. A delivery that was handed over is
  // withdrawn by name in the new instruction, and the run records what it
  // replaced; one that was never attempted is simply dropped. A CONFIRMED
  // delivery still refuses: the worker is known to be working from that wording,
  // and the operator reconciles it rather than withdrawing it underneath them.
  //
  // A NATIVE host is the exception. There a handed-over command sits in a durable
  // queue that nothing may cancel (`worker-input` refuses to cancel a
  // Farmslot-issued command), so the withdrawn turn can still run, finish and
  // write its own terminal signal — and a withdrawal in the text of a message
  // that arrives after it does not help. That one keeps refusing until the
  // original is reconciled.
  let superseded: CompletionDelivery | undefined;
  const retainedBefore = delivery;
  if (delivery && note !== undefined && note !== delivery.note) {
    if (delivery.confirmed)
      throw new Error(
        'Reconcile the retained completion feedback before changing its operator note',
      );
    if (delivery.startedAt !== undefined && initial.transport === 'native')
      throw new Error(
        'The retained completion feedback is queued on the worker host and cannot be withdrawn; reconcile it before changing its operator note',
      );
    if (delivery.startedAt !== undefined) superseded = delivery;
    console.warn(
      `[send-back] run ${run.id.slice(0, 8)} — ${superseded ? 'withdrawing' : 'dropping'} feedback ${delivery.key} in favour of this card's note`,
    );
    delivery = undefined;
  }
  const probe = await probeWorkerSignalForRun(run.id, slotId, context);
  // A withdrawn or dropped delivery leaves the same stale signal behind it: the
  // worker never wrote a new one, which is why its instruction was still
  // outstanding. Replacing that instruction is exactly the case that has to be
  // allowed to proceed on it, so the allowance follows whatever was retained
  // when this send-back started — not only the copy that survived. Keying it on
  // `superseded` alone stranded the next edit: a replacement that never reached
  // the composer leaves nothing retained, and the operator's next attempt then
  // failed on the signal probe instead of sending.
  const resumingStale =
    retainedBefore &&
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
      // Named, not just "ignore the previous message": the earlier text may
      // arrive after this one, so the worker needs to recognise which to drop.
      ...(superseded
        ? [
            `An earlier instruction for this task is withdrawn. If a message arrives, or has arrived, that says "Completion was refused" and${superseded.note ? ` carries the operator feedback "${superseded.note}"` : ' carries no operator feedback'}, ignore it and follow this one instead.`,
          ]
        : []),
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
          // History, so a run that was told two things shows both: the withdrawn
          // instruction is otherwise overwritten and only the log would know.
          ...(superseded
            ? {
                completionSendBackWithdrawn: [
                  // This runs for each persist of the same send-back (pending,
                  // then delivered), so the entry is replaced, not stacked.
                  ...(Array.isArray(previousOutputs?.completionSendBackWithdrawn)
                    ? previousOutputs.completionSendBackWithdrawn.filter(
                        (entry) =>
                          !(
                            entry &&
                            typeof entry === 'object' &&
                            'key' in entry &&
                            (entry as { key?: unknown }).key === superseded.key
                          ),
                      )
                    : []),
                  {
                    key: superseded.key,
                    ...(superseded.note ? { note: superseded.note } : {}),
                    startedAt: superseded.startedAt,
                    withdrawnAt: new Date().toISOString(),
                    withdrawnBy: next.key,
                  },
                ],
              }
            : {}),
        },
      });
      try {
        await persistRunNow(getRun(run.id)!, reason);
      } catch (error) {
        updateRunStep(run.id, PipelineSteps.DISPATCH, { outputs: previousOutputs });
        throw error;
      }
    });
  /**
   * Put a withdrawn instruction back exactly as it was.
   *
   * Overwriting the saved record is what makes a withdrawal durable, and until
   * the replacement is confirmed that is premature: on Claude and pi the
   * operator send is hook-only, so a composer still holding the old text makes
   * the new send hold rather than type over it — and the retry that would have
   * submitted the old text is gone, because the saved text no longer matches the
   * buffer. Restoring leaves the world as it was: same note retries, same
   * instruction submits.
   */
  const restoreSuperseded = async (replacementKey: string) => {
    if (!superseded) return;
    const restored = superseded;
    await withRunTransition(run.id, async () => {
      const latest = await assertOwner();
      const step = latest.steps.find((entry) => entry.name === PipelineSteps.DISPATCH)!;
      const previousOutputs = step.outputs;
      const history = Array.isArray(previousOutputs?.completionSendBackWithdrawn)
        ? previousOutputs.completionSendBackWithdrawn.filter(
            (entry) =>
              !(
                entry &&
                typeof entry === 'object' &&
                'withdrawnBy' in entry &&
                (entry as { withdrawnBy?: unknown }).withdrawnBy === replacementKey
              ),
          )
        : [];
      updateRunStep(run.id, PipelineSteps.DISPATCH, {
        outputs: {
          ...previousOutputs,
          completionSendBackDelivery: restored,
          ...(history.length
            ? { completionSendBackWithdrawn: history }
            : { completionSendBackWithdrawn: undefined }),
        },
      });
      await persistRunNow(getRun(run.id)!, 'withdrawn completion feedback restored');
    });
    console.warn(
      `[send-back] run ${run.id.slice(0, 8)} — replacement ${replacementKey} was not delivered; feedback ${restored.key} is retained again`,
    );
  };
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
    if (result.delivery !== 'confirmed') {
      await restoreSuperseded(intent.key);
      throw new Error(`Completion feedback delivery is ${result.delivery}; the run remains held.`);
    }
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
