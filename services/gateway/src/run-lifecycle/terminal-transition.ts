// terminal-transition.ts — the `complete` / `fail` / `block` plans for ADR-053's
// transition router.
//
// ADR-053 guaranteed publish-before-cleanup only for cancel. The engine's other
// three terminal paths did the opposite: `executeCompleteStep` and
// `executeCIWatchStep` ran `slotRelease` inside the step body, so the run only
// reached `done` after tmux teardown finished, and the fail/block branches wrote
// the terminal status but broadcast it only after `cleanupSlotAfterRunFailure`
// returned. Slow provider or tmux cleanup therefore delayed terminal visibility
// for every client.
//
// Here the caller hands over the patch it already built — the same status,
// error, metrics, and step records as before, so nothing about the run's
// content changes — and the router applies it, publishes through `onMutated`,
// and only then runs the teardown as awaited after-effects.

import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { isSlotFreedByPark } from '../run-engine/park-slot-binding.js';
import { getRun, updateRun } from '../runs/store.js';

import {
  effectFailed,
  routeRunTransition,
  type RunTransitionActor,
  type RunTransitionDeps,
  type RunTransitionEffect,
  type RunTransitionPlan,
  RunTransitionRefusedError,
  type RunTransitionRequest,
  type RunTransitionResult,
} from './transition-router.js';

/** The three terminal transitions the run engine owns. */
export type TerminalTransitionKind = 'complete' | 'fail' | 'block';

export interface TerminalTransitionCollaborators {
  settleBacklog(run: Run): Promise<void>;
  tickWorkGraph(graphId: string): Promise<unknown>;
  /** Eval harness teardown, ahead of the slot so its artifacts survive the reset. */
  cleanupEvalHarness(run: Run): Promise<void>;
  /**
   * Slot teardown, or `null` when this transition owes none.
   *
   * Null is the load-bearing case, not an optimisation: a CI-watch chain hands
   * the slot to its successor, a publication gate holds it for the operator, and
   * a run that never claimed one has nothing to release. Tearing down there
   * would take the slot out from under whoever holds it now.
   */
  cleanupSlot: ((run: Run) => Promise<void>) | null;
  /** Awaited by the router via `onMutated`, so a broadcast failure is reportable. */
  emit(run: Run): void | Promise<void>;
}

function terminalEffects(collaborators: TerminalTransitionCollaborators): RunTransitionEffect[] {
  return [
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
      // Same ordering rule as cancel: the scheduler reads backlog state, so a
      // tick that ran first would act on a pre-terminal item, and a tick after a
      // FAILED settle would schedule against state we know is stale.
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
      name: 'eval-harness-cleanup',
      severity: 'advisory',
      // Before the slot: the harness reads the slot's tree to finalize its
      // candidate package, and a reset slot no longer has one.
      apply: async ({ run }) => {
        await collaborators.cleanupEvalHarness(run);
      },
    },
    {
      name: 'slot-cleanup',
      severity: 'advisory',
      // Last, and the whole reason this module exists: tmux teardown is slow and
      // the terminal state was already published through `onMutated`, so no
      // client waits on it.
      apply: async ({ run }) => {
        if (!collaborators.cleanupSlot) {
          return { status: 'skipped' as const, detail: 'this transition owes no slot teardown' };
        }
        if (!run.slotId) return 'skipped';
        // A gate park already stopped this run's resources and published the
        // slot for dispatch. Killing agent windows or resetting a slot this run
        // no longer occupies would tear down its new occupant.
        if (isSlotFreedByPark(run)) {
          return {
            status: 'skipped' as const,
            detail: 'park already released slot ownership; the slot is free',
          };
        }
        await collaborators.cleanupSlot(run);
        return 'ok';
      },
    },
  ];
}

export interface TerminalTransitionRequest {
  runId: string;
  kind: TerminalTransitionKind;
  actor: RunTransitionActor;
  /**
   * The patch the caller already built. Applied as the router's single
   * mutation, unchanged: this module owns ORDERING, never the run's content.
   */
  patch: Partial<Run>;
  /**
   * The terminal status a previous writer already put on the run, when this
   * transition only settles it.
   *
   * The engine's backstop for a step that flipped `failed`/`blocked` without
   * throwing arrives with the run already terminal, so the default guard would
   * refuse it. Naming the status here relaxes the guard to exactly that value:
   * a run some other path settled — a cancel that won the race — is still
   * refused.
   */
  settlingStatus?: Run['status'];
  collaborators: TerminalTransitionCollaborators;
}

export function terminalPlan(
  request: TerminalTransitionRequest,
): (transitionRequest: RunTransitionRequest, run: Run) => RunTransitionPlan {
  return () => ({
    before: [],
    mutate: () => request.patch,
    after: terminalEffects(request.collaborators),
  });
}

export function terminalTransitionDeps(request: TerminalTransitionRequest): RunTransitionDeps {
  return {
    getRun,
    updateRun,
    planFor: terminalPlan(request),
    onMutated: (run) => request.collaborators.emit(run),
    guard: (run) => {
      if (request.settlingStatus !== undefined) {
        return run.status === request.settlingStatus
          ? null
          : `Run ${run.id} is '${run.status}', not the '${request.settlingStatus}' this transition settles`;
      }
      return isTerminalRunStatus(run.status)
        ? `Run ${run.id} already in terminal state: ${run.status}`
        : null;
    },
  };
}

/**
 * Applies one terminal transition, publishing before any teardown.
 *
 * Returns `null` when the guard refused — a normal outcome on these paths. An
 * operator cancel that landed while a step was failing already settled the run,
 * and the late engine transition must yield to it rather than throw out of the
 * engine's own catch block and reject `startRun`.
 */
export async function routeTerminalRunTransition(
  request: TerminalTransitionRequest,
): Promise<RunTransitionResult | null> {
  try {
    return await routeRunTransition(
      { kind: request.kind, runId: request.runId, actor: request.actor },
      terminalTransitionDeps(request),
    );
  } catch (error) {
    if (error instanceof RunTransitionRefusedError) {
      console.log(
        `[run-lifecycle] ${request.kind} transition for ${request.runId.slice(0, 8)} refused: ${(error as Error).message}`,
      );
      return null;
    }
    throw error;
  }
}
