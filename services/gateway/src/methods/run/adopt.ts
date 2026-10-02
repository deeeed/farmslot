import {
  Events,
  isTerminalRunStatus,
  primaryRoleForFlow,
  type RunAdoptParams,
  type RunAdoptResult,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { loadSlotVars, readSlotField } from '../../core/index.js';
import { acquireNativeWorkerRecovery } from '../../core/native-worker-exclusion.js';
import {
  bumpRunGeneration,
  cancelRunEngine,
  startRunWithStepAcknowledgement,
} from '../../run-engine/orchestrator.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { observeAdoptableTmuxWorker } from '../../runners/adopt-tmux.js';
import { cancelNativeRunWorkers } from '../../runners/native/worker.js';
import {
  confirmNativeWorkerStopped,
  readNativeWorkerSnapshot,
} from '../../runners/native/worker-control.js';
import {
  getRun,
  listRuns,
  persistRunNow,
  recordAdoptedTmuxWorker,
  updateRun,
} from '../../runs/store.js';
import { watchContext } from '../../tasks/watcher.js';

type Emit = (event: string, payload: unknown) => void;

export async function runAdopt(params: RunAdoptParams, emit: Emit): Promise<RunAdoptResult> {
  return withRunTransition(params.runId, async () => {
    const run = getRun(params.runId);
    if (
      !run ||
      isTerminalRunStatus(run.status) ||
      !run.slotId ||
      !run.taskFile ||
      !['blocked', 'paused'].includes(run.status)
    )
      throw new Error('Adoption requires a paused or blocked run with its task and owned slot');
    if (!params.tmux?.trim() || /[\r\n\t]/.test(params.tmux))
      throw new Error('Adoption requires one tmux session name');
    const slotId = run.slotId;
    const releaseRecovery = acquireNativeWorkerRecovery(slotId);
    try {
      const identity = () => {
        const current = getRun(run.id);
        const primary =
          current && selectAgentContext(current, { role: primaryRoleForFlow(current.flowType) });
        return JSON.stringify([
          current?.status,
          current?.transport,
          current?.slotId,
          current?.taskFile,
          current?.activeTaskFile,
          current?.engineState?.generation,
          primary?.id,
          primary?.runnerSessionId,
          primary?.nativeSession?.sessionId,
          primary?.nativeSession?.generation,
          primary?.nativeSession?.leaseId,
        ]);
      };
      const admissionIdentity = identity();
      if (
        listRuns({ active: true }).runs.some(
          (other) => other.id !== run.id && other.slotId === slotId,
        )
      )
        throw new Error('Another active run uses the adoption slot');
      const context = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
      if (!context) throw new Error('Run has no worker context to adopt');
      if (params.confirmStopped === true && !context.nativeSession)
        throw new Error('Stop confirmation requires a retained native worker binding');
      if (
        run.agentContexts?.some(
          (item) =>
            item.id !== context.id &&
            ((item.nativeSession && !item.nativeSession.closedAt) || item.nativeSessionOwner),
        )
      )
        throw new Error('Other worker contexts must stop before external adoption');
      if (context.nativeSession) {
        if (params.confirmStopped === true) await confirmNativeWorkerStopped(run.id, context.id);
        const snapshot = await readNativeWorkerSnapshot(run.id, undefined, context.id);
        if (!snapshot.session.processStopped) {
          if (['closed', 'failed'].includes(snapshot.session.state))
            throw new Error(
              `Native cleanup is unconfirmed: ${snapshot.session.error ?? snapshot.session.recovery ?? 'descendant evidence is unavailable'}. After checking the unrecorded descendants, retry with --confirm-stopped.`,
            );
          throw new Error('Another live native worker owns this run');
        }
      } else if (context.target) {
        const vars = await loadSlotVars(slotId);
        try {
          await observeAdoptableTmuxWorker(vars, context, context.target.session);
          throw new Error('Another live tmux worker owns this run');
        } catch (error) {
          if ((error as Error).message === 'Another live tmux worker owns this run') throw error;
          // Missing target is allowed only when adopting that exact retained target.
          if (context.target.session !== params.tmux)
            throw new Error(
              'Existing worker ownership is uncertain; adopt its retained target or stop it first',
              { cause: error },
            );
        }
      }
      if ((await readSlotField(slotId, 'current_run_id')) !== run.id)
        throw new Error('Another run owns the adoption slot');
      const vars = await loadSlotVars(slotId);
      const adopted = await observeAdoptableTmuxWorker(vars, context, params.tmux);
      const observedOwner = await readSlotField(slotId, 'current_run_id');
      if (
        getRun(run.id) !== run ||
        identity() !== admissionIdentity ||
        (run.status !== 'paused' && run.status !== 'blocked') ||
        observedOwner !== run.id
      )
        throw new Error('Run or slot changed during worker adoption');
      cancelRunEngine(run.id);
      // Fence the retired reservation and settle queued input before its lease
      // is archived. A process crash alone does not close the gateway binding.
      if (context.nativeSession)
        await cancelNativeRunWorkers(run.id, { machineTransitionHeld: true });
      const retiredOwner = await readSlotField(slotId, 'current_run_id');
      if (identity() !== admissionIdentity || retiredOwner !== run.id)
        throw new Error('Run or slot changed while retiring the native worker');
      const now = new Date().toISOString();
      const history = context.nativeSession
        ? [
            ...(context.nativeSessionHistory ?? []),
            { ...context.nativeSession, closedAt: now, releasedAt: now },
          ]
        : context.nativeSessionHistory;
      await persistRunNow(
        recordAdoptedTmuxWorker(run.id, {
          transport: 'tmux',
          status: 'monitoring',
          error: undefined,
          metrics: {
            ...run.metrics,
            runnerSessionId: adopted.runnerSessionId,
            runnerSessionPath: adopted.runnerSessionPath,
          },
          agentContexts: run.agentContexts?.map((item) =>
            item.id === context.id
              ? {
                  ...item,
                  status: 'working',
                  error: undefined,
                  nativeSession: undefined,
                  nativeSessionOwner: undefined,
                  nativeSessionHistory: history,
                  runnerSessionId: adopted.runnerSessionId,
                  runnerSessionPath: adopted.runnerSessionPath,
                  target: { session: params.tmux, target: adopted.paneId, paneId: adopted.paneId },
                  adoptedAt: now,
                }
              : item,
          ),
          decisions: run.decisions.map((decision) =>
            !decision.resolvedAt && decision.type === 'monitor_interactive_handoff'
              ? { ...decision, resolvedAt: now, resolvedAction: 'adopted' }
              : decision,
          ),
          steps: run.steps.map((step) =>
            step.name === 'monitor' ? { ...step, status: 'running', completedAt: undefined } : step,
          ),
        }),
        'external worker adoption',
      );
      const generation = bumpRunGeneration(run.id);
      try {
        const adoptedContext = getRun(run.id)!.agentContexts!.find(
          (item) => item.id === context.id,
        )!;
        await watchContext(slotId, adoptedContext, {
          assertCurrent: async () => {
            if (getRun(run.id)?.engineState?.generation !== generation)
              throw new Error('Adoption monitor generation changed');
          },
        });
        await startRunWithStepAcknowledgement(run.id, generation);
      } catch (error) {
        updateRun(run.id, {
          status: 'paused',
          error: `Worker adoption is recorded, but monitoring failed. Use farmslot run resume ${run.id}. ${(error as Error).message}`,
        });
        throw error;
      }
      const current = getRun(run.id)!;
      emit(Events.RUN_UPDATED, { run: current });
      return { run: current };
    } finally {
      releaseRecovery();
    }
  });
}
