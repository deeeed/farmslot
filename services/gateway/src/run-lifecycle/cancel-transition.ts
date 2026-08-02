// cancel-transition.ts — the `cancel` plan for ADR-052's transition router.
//
// This is the first transition migrated off implicit event-bus propagation. Before
// it, `run.cancel` held the per-request `emit` (one socket), so the backlog item kept
// `status: 'running'` and the work-graph node was never told; the scheduler only
// discovered the stop later by polling and inferring it from run fields (#466).

import { Events, type Run } from '@farmslot/protocol';

import { markBacklogRunObserved } from '../backlog/store.js';
import { cancelRunEngine } from '../run-engine/orchestrator.js';
import { getRun, updateRun } from '../runs/store.js';
import { invalidateWarmReviewerSessions } from '../self-review/session-policy.js';
import { schedulerTick } from '../work-graph/store.js';

import {
  type RunTransitionDeps,
  type RunTransitionEffect,
  type RunTransitionPlan,
  type RunTransitionRequest,
} from './transition-router.js';

export interface CancelCollaborators {
  cancelEngine(runId: string): void;
  invalidateWarmSessions(runId: string): void;
  settleBacklog(run: Run): Promise<void>;
  tickWorkGraph(graphId: string): Promise<unknown>;
  releaseSlot(run: Run): Promise<void>;
  emit(event: string, payload: unknown): void;
}

function cancelEffects(collaborators: CancelCollaborators): {
  before: RunTransitionEffect[];
  after: RunTransitionEffect[];
} {
  return {
    before: [
      {
        name: 'engine-cancel',
        severity: 'required',
        // Stop the engine before the terminal status is published so no in-flight
        // step writes after it.
        apply: async ({ run }) => {
          collaborators.cancelEngine(run.id);
        },
      },
      {
        name: 'warm-sessions',
        severity: 'required',
        // A cancelled run's warm reviewer sessions must never be resumable.
        apply: async ({ run }) => {
          collaborators.invalidateWarmSessions(run.id);
        },
      },
    ],
    after: [
      {
        name: 'backlog-settle',
        severity: 'advisory',
        apply: async ({ run }) => {
          await collaborators.settleBacklog(run);
        },
      },
      {
        name: 'work-graph-tick',
        severity: 'advisory',
        // Ordered after the settle: the scheduler reads backlog state, so ticking
        // first would let it act on a pre-cancel item.
        apply: async ({ run }) => {
          if (!run.workGraphId) return 'skipped';
          await collaborators.tickWorkGraph(run.workGraphId);
          return 'ok';
        },
      },
      {
        name: 'slot-release',
        severity: 'advisory',
        // Last: tmux teardown is slow, and the terminal state was already published
        // through `onMutated`, so Command Center does not wait on it.
        apply: async ({ run }) => {
          if (!run.slotId) return 'skipped';
          await collaborators.releaseSlot(run);
          return 'ok';
        },
      },
    ],
  };
}

export function cancelPlan(
  request: RunTransitionRequest,
  collaborators: CancelCollaborators,
): RunTransitionPlan {
  const { before, after } = cancelEffects(collaborators);
  return {
    before,
    mutate: (run) => {
      const completedAt = new Date().toISOString();
      return {
        status: 'cancelled',
        completedAt,
        error: request.reason ?? 'Cancelled by user',
        steps: run.steps.map((step) =>
          step.status === 'running' || step.status === 'pending'
            ? { ...step, status: 'skipped' as const, completedAt }
            : step,
        ),
        metrics: { ...run.metrics, outcome: 'cancelled' },
        agentContexts: [],
      };
    },
    after,
  };
}

export function cancelTransitionDeps(collaborators: CancelCollaborators): RunTransitionDeps {
  return {
    getRun,
    updateRun,
    planFor: (request) => cancelPlan(request, collaborators),
    onMutated: (run) => collaborators.emit(Events.RUN_UPDATED, { run }),
  };
}

/**
 * Production collaborators. Slot teardown is imported lazily to keep the
 * `core`/`methods/slot` chain out of the transition module's import graph.
 */
export function defaultCancelCollaborators(
  emit: (event: string, payload: unknown) => void,
): CancelCollaborators {
  return {
    cancelEngine: cancelRunEngine,
    invalidateWarmSessions: invalidateWarmReviewerSessions,
    settleBacklog: (run) => markBacklogRunObserved(run),
    tickWorkGraph: (graphId) => schedulerTick({ graphId }),
    releaseSlot: async (run) => {
      const { loadSlotVars, resetSlot } = await import('../core/index.js');
      const { killAgentInSession, killAllAgentWindows } = await import('../methods/slot.js');
      const { loadFleetStatus } = await import('../fleet/state.js');
      const vars = await loadSlotVars(run.slotId!);
      await killAllAgentWindows(vars);
      // After role-scoped windows are gone, clean the base pane as a legacy
      // fallback. Do not infer a role from the flow here: cancelled legacy runs
      // can have stale/null flow metadata while their worker lives elsewhere.
      await killAgentInSession(vars, run.metrics.runner ?? undefined);
      await resetSlot(run.slotId!, true);
      emit(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
      console.log(`[run-lifecycle] released slot ${run.slotId} on cancel`);
    },
    emit,
  };
}
