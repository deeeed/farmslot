// cancel-transition.ts — the `cancel` plan for ADR-053's transition router.
//
// This is the first transition migrated off implicit event-bus propagation. Before
// it, `run.cancel` held the per-request `emit` (one socket), so the backlog item kept
// `status: 'running'` and the work-graph node was never told; the scheduler only
// discovered the stop later by polling and inferring it from run fields (#466).

import { Events, isSlotFreedByPark, type Run } from '@farmslot/protocol';

import { markBacklogRunObserved } from '../backlog/store.js';
import { cancelRunEngine } from '../run-engine/orchestrator.js';
import { cancelNativeRunWorkers } from '../runners/native/worker.js';
import { getRun, updateRun } from '../runs/store.js';
import { invalidateWarmReviewerSessions } from '../self-review/session-policy.js';
import { schedulerTick } from '../work-graph/store.js';

import {
  fenceRunSlotCleanup,
  recordSlotTeardownBlocker,
  releaseRunOwnedCapabilities,
  releaseRunSlotOwnership,
  type RunSlotCleanupFence,
  settleFailedRunSlotCleanup,
  stopRunOwnedTmuxAndWatches,
} from './slot-teardown.js';
import {
  effectFailed,
  type RunTransitionActor,
  type RunTransitionDeps,
  type RunTransitionEffect,
  type RunTransitionPlan,
  type RunTransitionRequest,
  type RunTransitionSyncEffect,
} from './transition-router.js';

interface SkippedSlotRelease {
  skipped: string;
}

export interface CancelCollaborators {
  cancelEngine(runId: string): void;
  invalidateWarmSessions(runId: string): void;
  settleBacklog(run: Run): Promise<void>;
  tickWorkGraph(graphId: string): Promise<unknown>;
  releaseCapabilities(run: Run): Promise<void>;
  releaseSlot(run: Run): Promise<void | SkippedSlotRelease>;
  releaseWorkspace?(run: Run): Promise<void>;
  /** Awaited by the router via `onMutated`, so a broadcast failure is reportable. */
  emit(event: string, payload: unknown): void | Promise<void>;
}

/** An engine- or recovery-driven cancel must not claim an operator did it. */
const DEFAULT_CANCEL_REASON: Record<RunTransitionActor, string> = {
  operator: 'Cancelled by user',
  engine: 'Cancelled by the run engine',
  recovery: 'Cancelled during recovery',
};

function cancelEffects(collaborators: CancelCollaborators): {
  before: RunTransitionSyncEffect[];
  after: RunTransitionEffect[];
} {
  return {
    before: [
      {
        name: 'engine-cancel',
        severity: 'required',
        // Synchronous: aborting the engine must land in the same tick as the
        // mutation, or the engine can publish between the guard and the terminal
        // status. Both collaborators are sync today; the type enforces it.
        apply: ({ run }) => {
          collaborators.cancelEngine(run.id);
        },
      },
      {
        name: 'warm-sessions',
        severity: 'required',
        // A cancelled run's warm reviewer sessions must never be resumable.
        apply: ({ run }) => {
          collaborators.invalidateWarmSessions(run.id);
        },
      },
    ],
    after: [
      {
        name: 'review-workspace',
        severity: 'advisory',
        apply: async ({ run }) => {
          if (!run.reviewWorkspace) return 'skipped';
          if (!collaborators.releaseWorkspace)
            throw new Error('Workspace cancellation cleanup is unavailable');
          await collaborators.releaseWorkspace(run);
          return 'ok';
        },
      },
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
        // first would let it act on a pre-cancel item. If the settle actually
        // failed, ticking would schedule against state we know is stale — the
        // exact shape of the redispatch bug this router exists to prevent — so
        // bail and leave the periodic reconciler to recover.
        apply: async ({ run, outcomes }) => {
          if (effectFailed(outcomes, 'backlog-settle')) {
            return {
              status: 'skipped' as const,
              detail: 'backlog-settle failed; refusing to schedule against stale backlog state',
            };
          }
          if (!run.workGraphId) return 'skipped';
          await collaborators.tickWorkGraph(run.workGraphId);
          return 'ok';
        },
      },
      {
        name: 'runtime-capabilities',
        severity: 'advisory',
        apply: async ({ run }) => {
          if (!run.slotId) return 'skipped';
          // A gate park already stopped every provider this run owned and then
          // published the slot for dispatch. Reconciling terminal posture now
          // would act on leases and keep-warm providers of whoever claimed it.
          if (isSlotFreedByPark(run)) {
            return {
              status: 'skipped' as const,
              detail: "park already stopped this run's providers and freed the slot",
            };
          }
          await collaborators.releaseCapabilities(run);
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
          // Same reason, one step further: killing agent windows and resetting a
          // slot this run no longer owns would tear down its new occupant. The
          // park left the slot ready and unowned, which is the end state cancel
          // wants anyway.
          if (isSlotFreedByPark(run)) {
            return {
              status: 'skipped' as const,
              detail: 'park already released slot ownership; the slot is free',
            };
          }
          const result = await collaborators.releaseSlot(run);
          if (result?.skipped) return { status: 'skipped' as const, detail: result.skipped };
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
        error: request.reason ?? DEFAULT_CANCEL_REASON[request.actor],
        // Write-ahead repair marker. The terminal state is published before the
        // awaited backlog settle, so archive/delete must see this synchronously and
        // refuse eviction until markBacklogRunObserved clears it after a durable write.
        backlogReconcilePending: true,
        steps: run.steps.map((step) =>
          step.status === 'running' || step.status === 'pending'
            ? { ...step, status: 'skipped' as const, completedAt }
            : step,
        ),
        metrics: { ...run.metrics, outcome: 'cancelled' },
        // Both transports need their exact worker identities during terminal cleanup.
        // Keep them afterward so an unconfirmed stop retains its ownership evidence.
        agentContexts: run.agentContexts ?? [],
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
 * Publishes to every connected client, not just a requesting socket.
 *
 * A cancel is terminal and changes state every client renders. Leaving
 * publication to the caller made reach depend on which emitter that caller
 * happened to hold: the RPC route's per-request `emit` reaches one socket, while
 * `chat.confirmAction` and `run.interactiveDevResolve` hold their own. Owning it
 * here makes every cancel entry point publish identically.
 *
 * Imported lazily for the same reason `chat-tools.ts` does it: a static import
 * would close a server -> run-lifecycle -> server cycle.
 */
async function broadcastTransitionEvent(event: string, payload: unknown): Promise<void> {
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(event, payload);
}

/**
 * Production collaborators. Slot teardown is imported lazily to keep the
 * `core`/`methods/slot` chain out of the transition module's import graph.
 */
export function defaultCancelCollaborators(): CancelCollaborators {
  const cleanup = new Map<
    string,
    { fence: RunSlotCleanupFence; blocker: string | null; succeeded: boolean }
  >();
  return {
    releaseWorkspace: async (run) => {
      const { teardownReviewWorkspace } = await import('../review-workspaces/pipeline.js');
      await teardownReviewWorkspace(run.id);
    },
    cancelEngine: cancelRunEngine,
    invalidateWarmSessions: invalidateWarmReviewerSessions,
    settleBacklog: (run) => markBacklogRunObserved(run),
    tickWorkGraph: (graphId) => schedulerTick({ graphId }),
    releaseCapabilities: async (run) => {
      const state = {
        fence: { before: null } as RunSlotCleanupFence,
        blocker: null as string | null,
        succeeded: false,
      };
      cleanup.set(run.id, state);
      const { readSlotRow } = await import('../core/index.js');
      state.fence.before = run.slotId ? await readSlotRow(run.slotId) : null;
      if (run.transport === 'native')
        await cancelNativeRunWorkers(run.id, { machineTransitionHeld: true });
      const workerBlocker = await stopRunOwnedTmuxAndWatches(run);
      const blocker = await recordSlotTeardownBlocker(run, workerBlocker);
      state.fence = await fenceRunSlotCleanup(run, blocker);
      state.blocker = blocker;
      await releaseRunOwnedCapabilities(run, Boolean(blocker));
      state.succeeded = true;
    },
    releaseSlot: async (run) => {
      const state = cleanup.get(run.id);
      const blocker = state
        ? state.succeeded
          ? state.blocker
          : 'Run-owned provider cleanup was not confirmed'
        : await recordSlotTeardownBlocker(run);
      const fence = state?.fence ?? (await fenceRunSlotCleanup(run, blocker));
      cleanup.delete(run.id);
      try {
        const { readSlotField, updateSlotStatusIf } = await import('../core/index.js');
        const { loadFleetStatus } = await import('../fleet/state.js');
        if (run.transport === 'native') {
          await cancelNativeRunWorkers(run.id, { machineTransitionHeld: true });
          // A completed handoff can leave the prior run cancellable while its successor
          // owns this slot. Stop only this run's leases and leave the successor's slot alone.
          if ((await readSlotField(run.slotId!, 'current_run_id')) !== run.id) {
            await updateSlotStatusIf(
              run.slotId!,
              (slot) => slot.current_run_id !== run.id && slot.handoff_run_id === run.id,
              { handoff_run_id: null },
            );
            return;
          }
        }
        const reset = await releaseRunSlotOwnership(run, fence, blocker);
        if (blocker) return { skipped: blocker };
        if (!reset) return { skipped: 'Slot ownership changed during cancellation' };
        await broadcastTransitionEvent(Events.FLEET_UPDATED, { fleet: await loadFleetStatus() });
        console.log(`[run-lifecycle] released slot ${run.slotId} on cancel`);
      } catch (error) {
        await settleFailedRunSlotCleanup(run, fence, error);
        throw error;
      }
    },
    // Returned, not fire-and-forget: the router awaits `onMutated`, so a failed
    // dynamic import or broadcast surfaces as a failed `publish` effect on the cancel
    // result. Swallowing it here would leave other clients stale while the caller was
    // told the transition published cleanly.
    emit: (event, payload) => broadcastTransitionEvent(event, payload),
  };
}
