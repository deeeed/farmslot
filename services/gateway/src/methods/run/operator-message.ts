import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  Events,
  isTerminalRunStatus,
  primaryRoleForFlow,
  type TerminalSendParams,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { resolveNativeContext } from '../../agents/native-context.js';
import { loadSlotVars } from '../../core/config.js';
import { readSlotField } from '../../core/state.js';
import { resolveWorkerTaskDir } from '../../review/templates.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { readNativeWorkerSnapshot } from '../../runners/native/worker-control.js';
import { deliverOperatorInstructionWithIntent } from '../../runners/operator-instruction-intent.js';
import { getRun, persistRunNow, updateRun } from '../../runs/store.js';
import { currentSessionPrincipal } from '../../security/work-originator.js';
import {
  acceptanceInstructionPrompt,
  admitAcceptanceInstruction,
} from '../../tasks/acceptance-registration.js';
import { syncAcceptanceRegistration } from '../../tasks/acceptance-registration-sync.js';

type Emit = (event: string, payload: unknown) => void;

/** Existing semantic terminal input is the authenticated steering entry point. */
export async function operatorMessage(
  params: TerminalSendParams,
  emit: Emit,
): Promise<{ operatorMessageId: string; delivery: 'confirmed' | 'queued' } | null> {
  const owner = params.runId ?? (await readSlotField(params.slotId, 'current_run_id'));
  const initial = typeof owner === 'string' ? getRun(owner) : undefined;
  if (
    !initial?.acceptanceRegistration ||
    params.bareSession ||
    params.enter === false ||
    params.role === 'review'
  )
    return null;
  const selected = selectAgentContext(
    initial,
    params.contextId
      ? { contextId: params.contextId }
      : { role: params.role ?? primaryRoleForFlow(initial.flowType) },
  );
  if (selected?.role === 'review' || selected?.role === 'subtask') return null;
  if (!selected || (params.target && params.target !== selected.target?.target))
    throw new Error('Operator message target differs from the retained worker context');
  const principal = currentSessionPrincipal();
  if (!principal) throw new Error('Operator messages require an authenticated gateway session');
  const id = params.operatorMessageId;
  if (typeof id !== 'string' || !id.trim() || id.length > 256)
    throw new Error('operatorMessageId is required for retry-stable PR-completion steering');
  if (typeof params.text !== 'string' || !params.text.trim())
    throw new Error('Operator message text is required');
  const unitId = `derive-message-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
  const { continuePRCompletionStep } = await import('./replay-step.js');
  await continuePRCompletionStep(initial.id, 'monitor', emit, async () => {
    const run = getRun(initial.id);
    if (
      !run?.acceptanceRegistration ||
      isTerminalRunStatus(run.status) ||
      run.slotId !== params.slotId ||
      (await readSlotField(params.slotId, 'current_run_id')) !== run.id
    )
      throw new Error('Operator message run no longer owns this slot');
    const context = selectAgentContext(run, { contextId: selected.id });
    if (!context) throw new Error('Operator message worker context changed');
    if (
      !run.acceptanceRegistration.units.some(({ id }) => id === unitId) &&
      resolveNativeContext(run, context)
    ) {
      const snapshot = await readNativeWorkerSnapshot(run.id, context.role, context.id);
      if (snapshot.commands.some((command) => command.commandId === id))
        throw new Error('operatorMessageId already belongs to another native worker command');
    }
    const registration = admitAcceptanceInstruction(run.acceptanceRegistration, {
      id: unitId,
      sources: [
        {
          id: `message:${id}`,
          kind: 'instruction',
          body: params.text,
          version: createHash('sha256').update(params.text).digest('hex'),
        },
      ],
      delivery: {
        status: 'pending',
        principalId: principal.id,
        contextId: context.id,
        commandId: id,
      },
    });
    const fresh = registration !== run.acceptanceRegistration;
    if (fresh)
      await persistRunNow(
        updateRun(run.id, { acceptanceRegistration: registration }),
        'operator acceptance instruction admitted',
      );
    const reviewing = run.agentContexts?.some(
      (context) =>
        context.role === 'review' && ['launching', 'working', 'waiting'].includes(context.status),
    );
    return (
      fresh &&
      !reviewing &&
      run.status !== 'reviewing' &&
      run.status !== 'fixing' &&
      (run.steps.some(({ name, status }) => name === 'monitor' && status === 'done') ||
        run.decisions.some(
          (decision) => !decision.resolvedAt && decision.payload?.kind === 'output-review',
        ))
    );
  });
  const run = getRun(initial.id)!;
  const prior = run.acceptanceRegistration!.units.find(({ id }) => id === unitId)!;
  if (prior.delivery?.contextId !== selected.id)
    throw new Error('operatorMessageId already belongs to a different worker context');
  if (prior.delivery?.status === 'confirmed')
    return { operatorMessageId: id, delivery: 'confirmed' };
  const vars = await loadSlotVars(params.slotId);
  const generation = run.engineState?.generation ?? 0;
  const relative = await resolveWorkerTaskDir(vars, run.project, run.taskFile);
  if (!relative) throw new Error('Operator instruction task directory is unavailable');
  const taskDir = path.posix.join(vars.remoteRepo, relative);
  await syncAcceptanceRegistration(run.id, params.slotId, vars, taskDir);
  const result = await deliverOperatorInstructionWithIntent(
    async () => getRun(run.id)!,
    {
      key: unitId,
      text: acceptanceInstructionPrompt(prior),
      contextId: prior.delivery?.contextId,
      commandId: id,
    },
    {
      recordPending: (begin) =>
        withRunTransition(run.id, async () => {
          const latest = getRun(run.id);
          if (
            !latest?.acceptanceRegistration ||
            isTerminalRunStatus(latest.status) ||
            latest.slotId !== params.slotId ||
            (latest.engineState?.generation ?? 0) !== generation ||
            (await readSlotField(params.slotId, 'current_run_id')) !== latest.id
          )
            throw new Error('Operator instruction lost its run or slot owner before delivery');
          const unit = latest.acceptanceRegistration.units.find(({ id }) => id === unitId)!;
          if (unit.delivery?.status === 'confirmed') return null;
          const window = begin(unit.delivery?.startedAt);
          const { startedAt } = window;
          await persistRunNow(
            updateRun(run.id, {
              acceptanceRegistration: {
                ...latest.acceptanceRegistration,
                units: latest.acceptanceRegistration.units.map((row) =>
                  row.id === unitId
                    ? { ...row, delivery: { ...unit.delivery!, status: 'pending', startedAt } }
                    : row,
                ),
              },
            }),
            'operator instruction delivery intent',
          );
          return window;
        }),
      clearPending: (startedAt) =>
        withRunTransition(run.id, async () => {
          const current = getRun(run.id);
          if (
            !current?.acceptanceRegistration ||
            (current.engineState?.generation ?? 0) !== generation
          )
            return;
          await persistRunNow(
            updateRun(run.id, {
              acceptanceRegistration: {
                ...current.acceptanceRegistration,
                units: current.acceptanceRegistration.units.map((unit) => {
                  if (unit.id !== unitId || !unit.delivery || unit.delivery.startedAt !== startedAt)
                    return unit;
                  const delivery = { ...unit.delivery };
                  delete delivery.startedAt;
                  return { ...unit, delivery };
                }),
              },
            }),
            'untouched operator instruction can retry',
          );
        }),
    },
  );
  const { delivery, startedAt } = result;
  if (delivery === 'confirmed' && startedAt === undefined)
    return { operatorMessageId: id, delivery };
  if (delivery === 'not-attempted') {
    throw new Error(
      `Operator instruction was not sent. Retry with operatorMessageId ${id} when the retained worker is ready.`,
    );
  }
  if (delivery === 'unconfirmed') {
    emit(Events.RUN_UPDATED, { run: getRun(run.id) });
    throw new Error(
      `Operator instruction delivery is unconfirmed. Retry with operatorMessageId ${id}; its derivation remains pending.`,
    );
  }
  await withRunTransition(run.id, async () => {
    const latest = getRun(run.id);
    if (
      !latest ||
      isTerminalRunStatus(latest.status) ||
      latest.slotId !== params.slotId ||
      (latest.engineState?.generation ?? 0) !== generation ||
      (await readSlotField(params.slotId, 'current_run_id')) !== latest.id
    )
      throw new Error('Operator instruction lost its run or slot owner during delivery');
    if (delivery === 'confirmed')
      updateRun(run.id, {
        acceptanceRegistration: {
          ...latest.acceptanceRegistration!,
          units: latest.acceptanceRegistration!.units.map((unit) =>
            unit.id === unitId
              ? {
                  ...unit,
                  delivery: {
                    status: 'confirmed',
                    principalId: prior.delivery?.principalId ?? principal.id,
                    contextId: prior.delivery?.contextId,
                    commandId: id,
                    startedAt,
                    acceptedAt: new Date().toISOString(),
                  },
                }
              : unit,
          ),
        },
      });
  });
  await syncAcceptanceRegistration(run.id, params.slotId, vars, taskDir);
  emit(Events.RUN_UPDATED, { run: getRun(run.id) });
  return { operatorMessageId: id, delivery };
}
