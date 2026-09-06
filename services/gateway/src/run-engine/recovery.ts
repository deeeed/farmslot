// run-engine/recovery.ts — restart recovery and orphan slot reconciliation.

import path from 'node:path';

import {
  type ArtifactRef,
  Events,
  FLOW_STEPS,
  type FlowType,
  PipelineSteps,
  type ReviewGatePayload,
  type Run,
  type RunCreateParams,
  type RunStep,
  type SubStepRecord,
} from '@farmslot/protocol';

import type { ProjectVars, RawProjectJson, SlotVars } from '../core/config.js';
import { SLOT_PHASE_RELEASING } from '../core/state.js';
import { activeRunSlotIds } from '../methods/dispatch/slot-scoring.js';
import { isLeakedGatewayTestRun } from '../runs/test-run-leak.js';

import { pendingDecisionForRun } from './decision-projection.js';
import { pendingIndependentReviewContinuation } from './gate-policy.js';
import { isGateParkInFlightOrFreed } from './park-slot-binding.js';
import {
  type PublicationReviewRecoveryResult,
  reviewerContextNeedsRecovery,
} from './recover-inflight-reviews.js';
import { reviewPostingActions } from './review-gate.js';
import { recoveryReviewPlanForActiveFix } from './review-plan.js';

const S = PipelineSteps;
const RECONCILE_INTERVAL_MS = 60_000; // 60s
let orphanReconcileInFlight = false;

type PublicationReviewRecoveryState = NonNullable<
  NonNullable<Run['engineState']>['publishGate']
>['reviewRecovery'];

interface FleetSlotSnapshot {
  slot: string;
  lifecycle: string;
  phase?: string | null;
  agent?: string;
}

interface FleetSnapshot {
  slots: FleetSlotSnapshot[];
}

interface ChainedRunSpec {
  flowType: FlowType;
  createParams: RunCreateParams;
  updateFields: Partial<Run>;
  engineFlags: { skipPrepare?: true; warmSessionReuse?: true };
}

interface ReviewArtifactsSnapshot {
  recommendation: string;
  hasReview: boolean;
  reviewMd: string;
  lineComments: Array<{ path: string; line: number; body: string; severity: string }>;
}

export interface RunRecoveryCollaborators {
  listRuns: (params: { active: true }) => { runs: Run[] };
  loadFleetStatus: (force?: boolean) => Promise<FleetSnapshot>;
  /**
   * Whether a terminal run's teardown currently owns this slot's lifecycle.
   *
   * Injected so the reconciler stays testable, and so a validation gateway that
   * runs no engine can answer `false` for every slot.
   */
  isTerminalTeardownInFlight: (slotId: string) => boolean;
  getRun: (runId: string) => Run | undefined;
  updateRun: (runId: string, fields: Partial<Run>) => void;
  updateRunStep: (runId: string, stepName: string, fields: Partial<RunStep>) => void;
  broadcast: (event: string, payload: unknown) => void;
  copyWorkerArtifacts: (runId: string) => Promise<void>;
  readReviewArtifacts: (runId: string) => Promise<ReviewArtifactsSnapshot>;
  loadProjectVarsOrNull: (
    project: string,
    context: string,
    runId?: string,
  ) => Promise<ProjectVars | null>;
  scanArtifacts: (taskDir: string) => Promise<ArtifactRef[]>;
  readTaskArtifactText: (
    taskFile: string | null | undefined,
    filename: string,
  ) => Promise<string | undefined>;
  setPrHealthOverlay: (
    slotId: string,
    overlay: {
      pr: number;
      conflict: boolean;
      ciPassed: number;
      ciFailed: number;
      ciPending: number;
      ciTotal: number;
      updatedAt: string;
    },
  ) => void;
  buildCIWatchChainedRunParams: (
    run: Run,
    dispatchAction: string | null | undefined,
    ciRepo?: string | null,
  ) => ChainedRunSpec | null;
  createRun: (params: RunCreateParams) => Run;
  applyChainedRunEngineFlags: (
    runId: string,
    flags: { skipPrepare?: true; warmSessionReuse?: true },
  ) => void;
  startRun: (runId: string) => Promise<void>;
  reconstructStepOutputs: (run: Run, stepName: string) => Record<string, unknown> | null;
  loadSlotVars: (slotId: string) => Promise<SlotVars>;
  getProjectFieldRaw: (projectJson: RawProjectJson, field: string) => unknown;
  expandTemplate: (template: string, slotVars: SlotVars, projectVars?: ProjectVars) => string;
  clearStalePrepareProcess: (
    slotVars: SlotVars,
    pidPath: string,
    context: string,
    cleanupPatterns: string[],
  ) => Promise<boolean>;
  expandHook: (
    hookName: string,
    projectJson: RawProjectJson,
    slotVars: SlotVars,
    projectVars: ProjectVars,
  ) => string;
  execOnSlot: (
    slotVars: SlotVars,
    command: string,
  ) => Promise<{ exitCode: number; stdout: string }>;
  getProjectField: (projectJson: RawProjectJson, field: string) => string;
  setRunFlags: (runId: string, flags: { warmRecovery?: true }) => void;
  resetSlot: (slotId: string) => Promise<void>;
  quarantineLeakedRun: (run: Run) => Promise<void>;
  reconcileRunAgentRuntime?: (run: Run) => Promise<void>;
  rearmHandoffAutoRecovery: (run: Run) => (() => void) | undefined;
  rearmPublicationReviewRecovery: (
    run: Run,
    options?: { replayPending?: boolean },
  ) => (() => void) | undefined;
  recoverInflightPublicationReviews: (
    runId: string,
    slotId: string,
  ) => Promise<PublicationReviewRecoveryResult>;
  replayHumanGate: (runId: string) => Promise<void>;
}

const STEP_TO_STATUS: Record<string, Run['status']> = {
  [S.GRADE]: 'grading',
  [S.WRITE_TASK]: 'writing-task',
  [S.FIND_SLOT]: 'slot-finding',
  [S.PREPARE]: 'preparing',
  [S.DISPATCH]: 'dispatching',
  [S.MONITOR]: 'monitoring',
  [S.SELF_REVIEW]: 'self-reviewing',
  [S.HUMAN_GATE]: 'human-gating',
  [S.FINALIZE]: 'completing',
  [S.COMPLETE]: 'completing',
  [S.CI_WATCH]: 'ci-watching',
};

export function markTerminalReviewArtifactOperatorRequired(
  deps: Pick<RunRecoveryCollaborators, 'updateRun'>,
  run: Run,
  message: string,
  recoveryForensics?: PublicationReviewRecoveryState,
): void {
  const now = new Date().toISOString();
  const previous = recoveryForensics ?? run.engineState?.publishGate?.reviewRecovery;
  deps.updateRun(run.id, {
    engineState: {
      ...run.engineState,
      publishGate: {
        ...run.engineState?.publishGate,
        reviewRecovery: {
          status: 'operator-required',
          attempts: Math.max(1, previous?.attempts ?? 0),
          startedAt: previous?.startedAt ?? now,
          updatedAt: now,
          lastError: message.slice(0, 200),
        },
      },
    },
  });
}

function terminalReviewRecoveryMessage(result: PublicationReviewRecoveryResult): string {
  return result.terminalErrors.map((error) => error.message).join('; ');
}

function readCiRepo(projectJson: RawProjectJson | undefined): string | undefined {
  const ci = projectJson?.ci;
  if (!ci || typeof ci !== 'object') return undefined;
  const repo = (ci as { repo?: unknown }).repo;
  return typeof repo === 'string' ? repo : undefined;
}

export function recoveryHealthIsReady(
  result: { exitCode: number; stdout: string },
  readyIndicator?: string | null,
): boolean {
  if (result.exitCode !== 0) return false;
  const value = result.stdout.trim();
  if (!value) return false;
  return readyIndicator ? value === readyIndicator : true;
}

export function isPublicationReviewRecoveryHeld(run: Run): boolean {
  if (run.status === 'human-gating') return true;
  if (run.status !== 'blocked') return false;
  if (run.engineState?.publishGate?.reviewRecovery?.status === 'operator-required') return true;
  return run.decisions.some(
    (decision) => decision.type === 'engine_human_gate' && !decision.resolvedAt,
  );
}

export function hasRecoverablePublicationReviewer(run: Run): boolean {
  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  return (run.agentContexts ?? []).some((context) =>
    reviewerContextNeedsRecovery(context, reviews, { includeFailed: true, includeBlocked: true }),
  );
}

export function hasPendingPublicationReviewContinuation(run: Run): boolean {
  return (
    pendingIndependentReviewContinuation(run.engineState?.publishGate?.independentReviews ?? []) !==
    undefined
  );
}

/**
 * Whether a prepare step's recorded sub-steps show prepare ran to completion.
 *
 * Every prepare that finishes its configured phases ends with a terminal
 * `health` sub-step — either a resolved value (`Health check — OK`) or a
 * profile skip (`Health check skipped …`). A prepare interrupted mid-flight
 * leaves the last sub-step as an earlier phase (`preflight`, `deps`, …) or an
 * in-progress health detail (`Verifying health…`, `Trying unlock…`), none of
 * which start with `Health check`.
 *
 * Recovery only trusts a post-restart health check when this returns true: a
 * live artifact health probe on a slot whose preflight never completed is not
 * evidence the slot was actually prepared (browser/webpack may be dead while a
 * stale artifact still satisfies a weak health hook).
 */
export function prepareSubstepsShowCompletion(prepareStep: RunStep | undefined): boolean {
  const outputs = prepareStep?.outputs as { subSteps?: SubStepRecord[] } | undefined;
  const subSteps = outputs?.subSteps;
  if (!Array.isArray(subSteps) || subSteps.length === 0) return false;
  const last = subSteps[subSteps.length - 1];
  return last.name === 'health' && (last.detail?.startsWith('Health check') ?? false);
}

export async function recoverActiveRuns(deps: RunRecoveryCollaborators): Promise<void> {
  const { runs: active } = deps.listRuns({ active: true });
  if (active.length === 0) return;

  const recoverable: Run[] = [];
  for (const run of active) {
    if (isLeakedGatewayTestRun(run)) {
      console.warn(
        `[run-engine] skipping recovery for leaked gateway test run ${run.id.slice(0, 8)}`,
      );
      await deps.quarantineLeakedRun(run);
    } else {
      recoverable.push(run);
    }
  }
  if (recoverable.length === 0) return;

  const fleet = await deps.loadFleetStatus();
  const deferSlotBoundRecovery = fleet.slots.length === 0 && recoverable.some((run) => run.slotId);
  if (deferSlotBoundRecovery) {
    console.warn('[run-engine] deferring slot-bound recovery: fleet snapshot is empty');
  }
  console.log(`[run-engine] recovering ${recoverable.length} active run(s)`);

  for (const run of recoverable) {
    if (deferSlotBoundRecovery && run.slotId) continue;
    if (
      run.engineState?.publishGate?.reviewRecovery?.status === 'watching' &&
      !isPublicationReviewRecoveryHeld(run)
    ) {
      run.engineState = {
        ...run.engineState,
        publishGate: {
          ...run.engineState.publishGate,
          reviewRecovery: undefined,
        },
      };
      deps.updateRun(run.id, { engineState: run.engineState });
    }
    const expectedSteps = FLOW_STEPS[run.flowType];
    if (expectedSteps) {
      const existingNames = new Set(run.steps.map((s) => s.name));
      for (const stepName of expectedSteps) {
        if (!existingNames.has(stepName)) {
          const idx = expectedSteps.indexOf(stepName);
          const insertAt = Math.min(idx, run.steps.length);
          run.steps.splice(insertAt, 0, { name: stepName, status: 'pending' });
          console.log(`[run-engine] backfilled step '${stepName}' for run ${run.id.slice(0, 8)}`);
        }
      }
      deps.updateRun(run.id, { steps: run.steps });
    }

    if (run.status === 'paused') {
      console.log(`[run-engine] run ${run.id.slice(0, 8)} — paused, skipping recovery`);
      continue;
    }

    // ADR-054 `free-slot`: the park published this run's slot for dispatch and
    // another run may already own it. Every slot-bound recovery below would act
    // on that foreign slot — reconciling agent runtime against its worker,
    // replaying the human gate on it, or re-arming publication-review recovery
    // there. A gate park is a durable wait like `paused`, so it is skipped the
    // same way. The pending decision is still re-broadcast, which touches no
    // slot, so clients keep showing the run waiting; resolving it stays refused
    // until a restore puts the run back on a slot.
    //
    // The in-flight predicate, not the occupancy one: a park interrupted after
    // its write-ahead record but before `slotFreedAt` stopped the worker on the
    // way down, and `run.resolveDecision` refuses that run for exactly as long.
    // Recovering it here would re-drive a gate the operator cannot answer.
    // `reconcileMachineParking` runs first (index.ts), so a free-slot intent
    // whose release did land is already finished by the time this reads it.
    if (isGateParkInFlightOrFreed(run)) {
      for (const decision of run.decisions.filter((candidate) => !candidate.resolvedAt)) {
        deps.broadcast(Events.RUN_DECISION_NEW, {
          runId: run.id,
          decision: pendingDecisionForRun(run, decision),
          slotId: run.slotId,
        });
      }
      console.log(
        `[run-engine] run ${run.id.slice(0, 8)} — gate-parked (slot freed for dispatch), skipping slot recovery`,
      );
      continue;
    }

    const recoveredFixPlan = recoveryReviewPlanForActiveFix(run);
    if (run.slotId && isPublicationReviewRecoveryHeld(run) && recoveredFixPlan.length > 0) {
      const pendingReviewPlan = run.engineState?.publishGate?.pendingReviewPlan ?? [];
      const recoveredRun =
        pendingReviewPlan.length > 0
          ? run
          : {
              ...run,
              engineState: {
                ...run.engineState,
                publishGate: {
                  ...run.engineState?.publishGate,
                  pendingReviewPlan: recoveredFixPlan,
                  pendingReviewPlanRequestedAt: new Date().toISOString(),
                },
              },
            };
      if (pendingReviewPlan.length === 0) {
        deps.updateRun(run.id, { engineState: recoveredRun.engineState });
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — restored publication review plan for active fix pass`,
        );
      }
      deps.rearmPublicationReviewRecovery(recoveredRun, { replayPending: true });
      continue;
    }

    // The original review verdict may have been persisted before the process
    // died, while the authorized fix/re-review continuation had not started.
    // There is no reviewer artifact left to ingest in that state: replay the
    // gate immediately so it resumes the persisted continuation itself.
    if (
      run.slotId &&
      isPublicationReviewRecoveryHeld(run) &&
      hasPendingPublicationReviewContinuation(run)
    ) {
      try {
        await deps.replayHumanGate(run.id);
      } catch (err) {
        console.warn(
          `[run-engine] run ${run.id.slice(0, 8)} — pending review continuation replay failed; re-arming: ${(err as Error).message.slice(0, 200)}`,
        );
        deps.rearmPublicationReviewRecovery(run, { replayPending: true });
      }
      continue;
    }

    // A gate-held reviewer survives a gateway restart in tmux, but the await
    // that owned it does not. Recover or re-arm that reviewer BEFORE generic
    // runtime reconciliation: reconciliation can otherwise observe a terminal
    // reviewer before the publish-gate await persists its result, after which
    // the stale human gate is rebroadcast and the completed review is never
    // ingested.
    if (
      run.slotId &&
      isPublicationReviewRecoveryHeld(run) &&
      hasRecoverablePublicationReviewer(run)
    ) {
      const recoveryForensics = run.engineState?.publishGate?.reviewRecovery
        ? { ...run.engineState.publishGate.reviewRecovery }
        : undefined;
      let recoveryResult: PublicationReviewRecoveryResult;
      try {
        recoveryResult = await deps.recoverInflightPublicationReviews(run.id, run.slotId);
      } catch (err) {
        console.warn(
          `[run-engine] run ${run.id.slice(0, 8)} — startup publication-review recovery failed: ${(err as Error).message.slice(0, 200)}`,
        );
        deps.rearmPublicationReviewRecovery(run);
        continue;
      }

      if (recoveryResult.recoveredIds.length > 0 || (recoveryResult.relaunchIds?.length ?? 0) > 0) {
        try {
          await deps.replayHumanGate(run.id);
        } catch (err) {
          if (recoveryResult.terminalErrors.length > 0) {
            markTerminalReviewArtifactOperatorRequired(
              deps,
              deps.getRun(run.id) ?? run,
              `${terminalReviewRecoveryMessage(recoveryResult)}; gate replay failed: ${(err as Error).message}`,
              recoveryForensics,
            );
            continue;
          }
          console.warn(
            `[run-engine] run ${run.id.slice(0, 8)} — recovered review gate replay failed; re-arming: ${(err as Error).message.slice(0, 200)}`,
          );
          deps.rearmPublicationReviewRecovery(run, { replayPending: true });
        }
        if (recoveryResult.terminalErrors.length > 0) {
          markTerminalReviewArtifactOperatorRequired(
            deps,
            deps.getRun(run.id) ?? run,
            terminalReviewRecoveryMessage(recoveryResult),
            recoveryForensics,
          );
        }
        continue;
      }

      if (recoveryResult.terminalErrors.length > 0) {
        markTerminalReviewArtifactOperatorRequired(
          deps,
          deps.getRun(run.id) ?? run,
          terminalReviewRecoveryMessage(recoveryResult),
          recoveryForensics,
        );
        continue;
      }

      if (deps.rearmPublicationReviewRecovery(run)) {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — re-armed publication-review recovery`,
        );
      }
      continue;
    }

    if (deps.reconcileRunAgentRuntime && run.slotId) {
      try {
        await deps.reconcileRunAgentRuntime(run);
      } catch (err) {
        console.warn(
          `[run-engine] tmux runtime reconciliation failed for ${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }

    if (run.status === 'blocked') {
      const unresolved = run.decisions.filter((d) => !d.resolvedAt);
      if (unresolved.length > 0) {
        for (const d of unresolved) {
          if (d.type === 'engine_review_posting' && run.taskFile) {
            try {
              await deps.copyWorkerArtifacts(run.id);
              const review = await deps.readReviewArtifacts(run.id);
              if (review.hasReview) {
                const pv = await deps.loadProjectVarsOrNull(run.project, 'run recovery', run.id);
                const ciRepo = readCiRepo(pv?.projectJson) ?? null;
                let recoveryArtifactManifest: ArtifactRef[] = [];
                if (run.taskFile) {
                  try {
                    recoveryArtifactManifest = await deps.scanArtifacts(path.dirname(run.taskFile));
                  } catch (err) {
                    console.warn(
                      `[run-engine] recovery artifact scan failed for ${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
                    );
                  }
                }

                const existingPayload = d.payload as ReviewGatePayload | undefined;
                const recoveredPayload: ReviewGatePayload = {
                  ...existingPayload,
                  kind: 'review',
                  prNumber: run.prNumber ?? null,
                  repo: ciRepo,
                  recommendation: review.recommendation,
                  reviewMd: review.reviewMd,
                  lineComments: review.lineComments,
                  artifactManifest:
                    recoveryArtifactManifest.length > 0 ? recoveryArtifactManifest : undefined,
                  recipeJson: await deps.readTaskArtifactText(run.taskFile, 'recipe.json'),
                };
                const recoveredDecisions = run.decisions.map((decision) =>
                  decision.id === d.id
                    ? {
                        ...decision,
                        payload: recoveredPayload,
                        actions: reviewPostingActions(review.reviewMd),
                      }
                    : decision,
                );
                deps.updateRun(run.id, { decisions: recoveredDecisions });
                console.log(`[run-engine] backfilled review payload for ${run.id.slice(0, 8)}`);
              }
            } catch (err) {
              console.warn(
                `[run-engine] failed to backfill blocked review payload for ${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
              );
            }
          }
        }
        // The gate loop that owned a pending human-gate decision died with the
        // previous process. Ingest reviewer results that finished while nobody
        // was watching; when that changed the gate's inputs — or a replay
        // already stacked a duplicate pending gate decision — re-enter the
        // gate so it presents ONE live decision reflecting current state. A
        // lone stale decision with nothing recovered is left in place:
        // loop-less resolution via runResolveDecision's restart fallback
        // handles it without re-presenting every gate on every restart.
        const gateDecisions = unresolved.filter((d) => d.type === 'engine_human_gate');
        if (gateDecisions.length > 0 && run.slotId) {
          const recoveryForensics = run.engineState?.publishGate?.reviewRecovery
            ? { ...run.engineState.publishGate.reviewRecovery }
            : undefined;
          let recoveryResult: PublicationReviewRecoveryResult = {
            recoveredIds: [],
            terminalErrors: [],
          };
          try {
            recoveryResult = await deps.recoverInflightPublicationReviews(run.id, run.slotId);
          } catch (err) {
            // A failed ingestion must not abort recovery of the remaining
            // runs; the gate stays pending and the operator path still works.
            console.warn(
              `[run-engine] run ${run.id.slice(0, 8)} — startup review ingestion failed: ${(err as Error).message.slice(0, 200)}`,
            );
          }
          const recoveredReviews = recoveryResult.recoveredIds.length;
          const relaunchedReviews = recoveryResult.relaunchIds?.length ?? 0;
          if (recoveredReviews > 0 || relaunchedReviews > 0 || gateDecisions.length > 1) {
            console.log(
              `[run-engine] run ${run.id.slice(0, 8)} — re-entering human gate after restart (${recoveredReviews} recovered review(s), ${relaunchedReviews} review(s) needing relaunch, ${gateDecisions.length} pending gate decision(s))`,
            );
            try {
              // Awaited: skip the stale rebroadcast only once the replay has
              // actually taken gate ownership (it supersedes the pending
              // decisions before presenting a fresh one; the engine resume it
              // schedules is detached, so this stays bounded).
              await deps.replayHumanGate(run.id);
              if (recoveryResult.terminalErrors.length > 0) {
                markTerminalReviewArtifactOperatorRequired(
                  deps,
                  deps.getRun(run.id) ?? run,
                  terminalReviewRecoveryMessage(recoveryResult),
                  recoveryForensics,
                );
              }
              continue;
            } catch (err) {
              if (recoveryResult.terminalErrors.length > 0) {
                markTerminalReviewArtifactOperatorRequired(
                  deps,
                  deps.getRun(run.id) ?? run,
                  `${terminalReviewRecoveryMessage(recoveryResult)}; gate replay failed: ${(err as Error).message}`,
                  recoveryForensics,
                );
                continue;
              }
              // Re-entry failed before establishing ownership — fall through
              // so whatever is STILL unresolved gets re-presented; suppressing
              // it would leave the operator with no actionable decision.
              console.warn(
                `[run-engine] run ${run.id.slice(0, 8)} — human-gate re-entry failed: ${(err as Error).message.slice(0, 200)}`,
              );
            }
          }
          if (recoveryResult.terminalErrors.length > 0) {
            markTerminalReviewArtifactOperatorRequired(
              deps,
              deps.getRun(run.id) ?? run,
              terminalReviewRecoveryMessage(recoveryResult),
              recoveryForensics,
            );
            continue;
          }
        }
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — blocked with ${unresolved.length} unresolved decision(s), re-presenting`,
        );
        const runningStep = run.steps.find((s) => s.status === 'running');
        if (runningStep?.detail && runningStep.name === S.HUMAN_GATE) {
          deps.updateRunStep(run.id, runningStep.name, {
            detail: 'Waiting for operator decision',
          });
        }
        for (const d of unresolved) {
          // Re-check at broadcast time: a replay that failed partway may have
          // superseded some of these before dying.
          if (d.resolvedAt) continue;
          deps.broadcast(Events.RUN_DECISION_NEW, {
            runId: run.id,
            decision: pendingDecisionForRun(run, d),
            slotId: run.slotId,
          });
        }
        // The auto-recovery watcher for a pending interactive handoff lived
        // inside the previous process's engine promise; without re-arming it,
        // a terminal signal written after the restart would sit unnoticed
        // until an operator round-trip.
        if (unresolved.some((d) => d.type === 'monitor_interactive_handoff')) {
          if (deps.rearmHandoffAutoRecovery(run)) {
            console.log(
              `[run-engine] run ${run.id.slice(0, 8)} — re-armed interactive-handoff auto-recovery`,
            );
          }
        }
        if (run.slotId && run.prNumber) {
          const hasConflict = unresolved.some((d) => d.type === 'ci_merge_conflict');
          const hasCIFail = unresolved.some((d) => d.type === 'ci_ci_failed');
          const hasCITimeout = unresolved.some((d) => d.type === 'ci_ci_timeout');
          if (hasConflict || hasCIFail || hasCITimeout) {
            deps.setPrHealthOverlay(run.slotId, {
              pr: run.prNumber,
              conflict: hasConflict,
              ciPassed: 0,
              ciFailed: hasCIFail ? 1 : 0,
              ciPending: hasCITimeout ? 1 : 0,
              ciTotal: 0,
              updatedAt: new Date().toISOString(),
            });
            console.log(
              `[run-engine] restored prHealth overlay for ${run.slotId} (conflict=${hasConflict})`,
            );
          }
        }
        continue;
      }

      if (run.decisions.length === 0) {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — blocked terminal state with no decisions; keeping blocked`,
        );
        continue;
      }
      const runningStepName = run.steps.find((s) => s.status === 'running')?.name;
      const latestResolvedGateDecision = [...run.decisions]
        .reverse()
        .find(
          (decision) =>
            (decision.type === 'engine_human_gate' || decision.type === 'engine_review_posting') &&
            !!decision.resolvedAt,
        );
      const supersededGateWithoutReplacement =
        runningStepName === S.HUMAN_GATE &&
        latestResolvedGateDecision?.resolvedAction === 'superseded';
      if (supersededGateWithoutReplacement) {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — superseded gate has no replacement, re-entering human gate`,
        );
        try {
          await deps.replayHumanGate(run.id);
        } catch (err) {
          const message = `Human-gate recovery needs an operator retry: ${(err as Error).message.slice(0, 160)}`;
          const current = deps.getRun(run.id) ?? run;
          markTerminalReviewArtifactOperatorRequired(deps, current, message);
          deps.updateRunStep(run.id, S.HUMAN_GATE, {
            detail: 'Review recovery failed — retry this gate to continue',
          });
          deps.broadcast(Events.RUN_UPDATED, {
            run: deps.getRun(run.id) ?? current,
          });
          console.error(`[run-engine] run ${run.id.slice(0, 8)} — ${message}`);
        }
        continue;
      }
      if (runningStepName === S.CI_WATCH) {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — blocked at terminal ci-watch step; keeping blocked`,
        );
        continue;
      }

      const runningStep = run.steps.find((s) => s.status === 'running');
      if (runningStep) {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — blocked with 0 unresolved decisions, advancing past ${runningStep.name}`,
        );
        const stepOutputs = deps.reconstructStepOutputs(run, runningStep.name);
        deps.updateRunStep(run.id, runningStep.name, {
          status: 'done',
          completedAt: new Date().toISOString(),
          ...(stepOutputs ? { outputs: stepOutputs } : {}),
        });

        if (runningStep.name === S.CI_WATCH && run.slotId) {
          const chainDecision = run.decisions.find(
            (d) =>
              d.resolvedAt &&
              (d.resolvedAction === 'dispatch-update-branch' ||
                d.resolvedAction === 'dispatch-pr-complete'),
          );
          if (chainDecision) {
            const pv = await deps.loadProjectVarsOrNull(run.project, 'run recovery', run.id);
            const chainSpec = deps.buildCIWatchChainedRunParams(
              run,
              chainDecision.resolvedAction,
              readCiRepo(pv?.projectJson),
            );
            if (!chainSpec) continue;
            console.log(
              `[run-engine] run ${run.id.slice(0, 8)} — chaining ${chainSpec.flowType} on slot ${run.slotId} (recovery)`,
            );
            deps.updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
            const chainRun = deps.createRun(chainSpec.createParams);
            deps.applyChainedRunEngineFlags(chainRun.id, chainSpec.engineFlags);
            if (Object.keys(chainSpec.updateFields).length)
              deps.updateRun(chainRun.id, chainSpec.updateFields);
            deps.broadcast(Events.RUN_UPDATED, { run: deps.getRun(chainRun.id) ?? chainRun });
            deps.startRun(chainRun.id).catch((err) => {
              console.error(
                `[run-engine] chained ${chainSpec.flowType} run failed: ${(err as Error).message}`,
              );
            });
            continue;
          }
        }

        const nextStep = run.steps.find((s) => s.status === 'pending');
        const restoredStatus = nextStep ? (STEP_TO_STATUS[nextStep.name] ?? 'created') : 'done';
        deps.updateRun(run.id, { status: restoredStatus });
      } else {
        deps.updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
      }
    }

    if (run.slotId) {
      const slot = fleet.slots.find((s) => s.slot === run.slotId);
      if (!slot) {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — slot ${run.slotId} gone, marking blocked`,
        );
        deps.updateRun(run.id, {
          status: 'blocked',
          error: 'Slot disappeared during gateway restart',
        });
        continue;
      }

      if (run.status === 'ci-watching') {
        const resolvedChain = run.decisions.find(
          (d) =>
            d.resolvedAt &&
            (d.resolvedAction === 'dispatch-update-branch' ||
              d.resolvedAction === 'dispatch-pr-complete'),
        );
        const ciStep = run.steps.find((s) => s.name === 'ci-watch');
        const alreadyChained =
          ciStep?.outputs && typeof ciStep.outputs === 'object'
            ? (ciStep.outputs as { chainedRunId?: unknown }).chainedRunId
            : undefined;
        if (resolvedChain && alreadyChained) {
          console.log(
            `[run-engine] run ${run.id.slice(0, 8)} — already chained to ${alreadyChained}, marking done`,
          );
          deps.updateRunStep(run.id, S.CI_WATCH, {
            status: 'done',
            completedAt: new Date().toISOString(),
          });
          deps.updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
          continue;
        }
        console.log(`[run-engine] run ${run.id.slice(0, 8)} — resuming CI monitoring`);
        deps.startRun(run.id).catch((err) => {
          console.error(
            `[run-engine] recovery failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
        continue;
      }

      if (run.status === 'monitoring') {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — resuming monitor (slot agent=${slot.agent ?? 'unknown'})`,
        );
        deps.startRun(run.id).catch((err) => {
          console.error(
            `[run-engine] recovery failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
        continue;
      }

      if (run.status === 'dispatching' && slot.agent === 'working') {
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — slot already working, advancing to monitoring`,
        );
        deps.updateRunStep(run.id, S.DISPATCH, {
          status: 'done',
          completedAt: new Date().toISOString(),
        });
        deps.updateRun(run.id, { status: 'monitoring' });
        deps.updateRunStep(run.id, S.MONITOR, {
          status: 'running',
          startedAt: new Date().toISOString(),
        });
      }

      if (run.status === 'preparing') {
        const prepareStep = run.steps.find((s) => s.name === 'prepare');
        if (prepareStep?.status === 'running') {
          try {
            const vars = await deps.loadSlotVars(run.slotId);
            const pv = await deps.loadProjectVarsOrNull(run.project, 'run recovery', run.id);
            const runtimeDir = pv?.runtimeDir || '.agent';
            const pidPath = `${vars.remoteRepo}/${runtimeDir}/preflight.pid`;
            const rawPatterns = deps.getProjectFieldRaw(pv?.projectJson ?? {}, 'cleanup_patterns');
            const cleanupPatterns = Array.isArray(rawPatterns)
              ? rawPatterns
                  .map((p) => deps.expandTemplate(String(p), vars, pv ?? undefined))
                  .filter(Boolean)
              : [];
            // If cleanup terminates a live in-flight prepare process, the slot is
            // no longer in a trustworthy state: the killed preflight was mid-way
            // through refreshing exactly the artifacts a health check inspects.
            let killedPrepareProcess = false;
            try {
              killedPrepareProcess = await deps.clearStalePrepareProcess(
                vars,
                pidPath,
                'recovery',
                cleanupPatterns,
              );
            } catch (cleanupErr) {
              console.warn(
                `[run-engine] run ${run.id.slice(0, 8)} — stale process cleanup failed: ${(cleanupErr as Error).message}, orphaned processes may still be running`,
              );
            }
            // The warm-recovery skip is only sound when nothing was killed AND
            // the recorded sub-steps prove prepare finished its phases. Either a
            // kill or incomplete sub-steps means a passing health probe can only
            // reflect stale artifacts, not a genuinely prepared slot.
            const substepsComplete = prepareSubstepsShowCompletion(prepareStep);
            const canTrustHealth = !killedPrepareProcess && substepsComplete;
            if (!canTrustHealth) {
              console.log(
                `[run-engine] run ${run.id.slice(0, 8)} — not trusting recovery health ` +
                  `(killedPrepareProcess=${killedPrepareProcess}, substepsComplete=${substepsComplete}), re-running prepare (warm)`,
              );
            }
            const healthHook =
              canTrustHealth && pv
                ? deps.expandHook('health_check', pv.projectJson, vars, pv)
                : null;
            if (healthHook) {
              let healthTimer: ReturnType<typeof setTimeout> | undefined;
              const hr = await Promise.race([
                deps.execOnSlot(vars, `cd '${vars.remoteRepo}' && ${healthHook} 2>/dev/null`),
                new Promise<never>((_, reject) => {
                  healthTimer = setTimeout(
                    () => reject(new Error('health check timeout (10s)')),
                    10000,
                  );
                }),
              ]).finally(() => {
                if (healthTimer) clearTimeout(healthTimer);
              });
              console.log(
                `[run-engine] run ${run.id.slice(0, 8)} — recovery health check: exit=${hr.exitCode} value="${hr.stdout.trim().slice(0, 80)}"`,
              );
              const readyIndicator = pv
                ? deps.getProjectField(pv.projectJson, 'health.ready_indicator')
                : '';
              if (recoveryHealthIsReady(hr, readyIndicator)) {
                console.log(
                  `[run-engine] run ${run.id.slice(0, 8)} — slot healthy after recovery, advancing past prepare`,
                );
                // Sub-steps already showed a completed prepare (canTrustHealth
                // gate), so leaving outputs intact keeps the record coherent with
                // the done state — the existing subSteps still end at `health`.
                deps.updateRunStep(run.id, 'prepare', {
                  status: 'done',
                  completedAt: new Date().toISOString(),
                  detail: 'Recovered (slot healthy)',
                });
                deps.updateRun(run.id, { status: 'dispatching' });
                deps.startRun(run.id).catch((err) => {
                  console.error(
                    `[run-engine] recovery failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
                  );
                });
                continue;
              }
            }
          } catch (err) {
            console.log(
              `[run-engine] run ${run.id.slice(0, 8)} — prepare recovery failed: ${(err as Error).message}`,
            );
          }
          console.log(
            `[run-engine] run ${run.id.slice(0, 8)} — slot not healthy, re-running prepare (warm)`,
          );
          deps.updateRunStep(run.id, 'prepare', {
            status: 'pending',
            detail: undefined,
            startedAt: undefined,
            completedAt: undefined,
          });
          deps.setRunFlags(run.id, { warmRecovery: true });
        }
      }
    }

    deps.startRun(run.id).catch((err) => {
      console.error(
        `[run-engine] recovery failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
      );
    });
  }

  await reconcileOrphanedSlots(deps);
}

export function startOrphanReconciler(deps: RunRecoveryCollaborators): void {
  const timer = setInterval(() => {
    if (orphanReconcileInFlight) return;
    orphanReconcileInFlight = true;
    reconcileOrphanedSlots(deps)
      .catch((err) => {
        console.error(`[run-engine] periodic reconcile error: ${(err as Error).message}`);
      })
      .finally(() => {
        orphanReconcileInFlight = false;
      });
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
}

export async function reconcileOrphanedSlots(deps: RunRecoveryCollaborators): Promise<void> {
  const { runs: active } = deps.listRuns({ active: true });
  // The shared occupancy predicate, not an inline status filter. A run whose
  // park freed its slot (ADR-054 `free-slot`) keeps `slotId` as its restore
  // target but is no longer the occupant, so counting it here would mask a
  // genuinely orphaned `busy`/`held` slot from reclamation forever. Sharing the
  // helper with dispatch and fleet refresh also stops the terminal-status list
  // from drifting — the inline version missed `cancelled`.
  const activeSlotIds = activeRunSlotIds(active);
  const freshFleet = await deps.loadFleetStatus(true);
  for (const slot of freshFleet.slots) {
    if (!['busy', 'held'].includes(slot.lifecycle) || activeSlotIds.has(slot.slot)) continue;
    // A terminal run's slot is NOT orphaned while its teardown is still
    // running. ADR-053 publishes the terminal status before the teardown, and
    // `activeRunSlotIds` counts only non-terminal runs, so for that window the
    // slot looks abandoned to this loop. Resetting it there republishes a slot
    // whose tmux windows are still being killed and whose worktree is still
    // being reset, straight into dispatch.
    if (deps.isTerminalTeardownInFlight(slot.slot)) {
      console.log(`[run-engine] reconcile: ${slot.slot} left alone; a terminal teardown owns it`);
      continue;
    }
    // Same reason, for a release this process did not start: the releasing
    // fence is the marker every other teardown path already respects.
    if (slot.phase === SLOT_PHASE_RELEASING) {
      console.log(`[run-engine] reconcile: ${slot.slot} left alone; a release owns it`);
      continue;
    }
    console.log(
      `[run-engine] reconcile: orphaned ${slot.slot} (${slot.lifecycle}/${slot.phase}) → ready`,
    );
    await deps.resetSlot(slot.slot);
  }
}
