import { PipelineSteps, primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { readSlotField } from '../core/state.js';
import { continuePRCompletionStep } from '../methods/run/replay-step.js';
import { probeWorkerSignalForRun } from '../run-engine/run-monitor.js';
import { deliverOperatorInstruction } from '../runners/operator-instruction.js';
import { getRun, persistRunNow, updateRunStep } from '../runs/store.js';
import { parseStrictIsoMs } from '../tasks/worker-signals.js';

/** Deliver the refusal to the retained worker before resuming its existing monitor. */
export async function sendBackCompletion(
  run: Run,
  decisionId: string,
  feedback: string,
  emit: (event: string, payload: unknown) => void,
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

  await assertOwner();
  const probe = await probeWorkerSignalForRun(run.id, slotId, context);
  const baseline = probe.signal;
  if (
    (!probe.ok && probe.code !== 'artifact_contract' && probe.code !== 'non_terminal') ||
    !baseline ||
    parseStrictIsoMs(baseline.timestamp) === null
  )
    throw new Error(`Cannot establish the worker signal before send-back: ${probe.message}`);
  const current = await assertOwner();
  const delivery = await deliverOperatorInstruction(
    current,
    `completion-send-back:${decisionId}`,
    [
      'Completion was refused. Fix the following problem in this task:',
      feedback,
      'Keep the existing task and evidence ownership rules. When fixed, write a new terminal signal with the task marking command. The previous completion signal will not be reused.',
    ].join('\n\n'),
    undefined,
    context.id,
  );
  if (delivery !== 'confirmed')
    throw new Error(`Completion feedback delivery is ${delivery}; the run remains held.`);

  // The replay and its acknowledgement share the transition lock. A concurrent
  // cancel cannot turn this continuation into a replay of a cancelled run.
  await continuePRCompletionStep(run.id, 'monitor', emit, async () => {
    const latest = await assertOwner();
    const dispatch = latest.steps.find((step) => step.name === PipelineSteps.DISPATCH);
    if (!dispatch) throw new Error('Completion send-back has no retained dispatch');
    const previousOutputs = dispatch.outputs;
    updateRunStep(run.id, PipelineSteps.DISPATCH, {
      outputs: { ...dispatch.outputs, completionSendBackSignal: baseline },
    });
    try {
      await persistRunNow(getRun(run.id)!, 'completion send-back signal baseline');
    } catch (error) {
      updateRunStep(run.id, PipelineSteps.DISPATCH, { outputs: previousOutputs });
      throw error;
    }
    return true;
  });
}
