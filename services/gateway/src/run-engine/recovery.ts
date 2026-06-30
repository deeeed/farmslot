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
} from '@farmslot/protocol';

import type { ProjectVars, RawProjectJson, SlotVars } from '../core/config.js';
import { isLeakedGatewayTestRun } from '../runs/test-run-leak.js';

const S = PipelineSteps;
const RECONCILE_INTERVAL_MS = 60_000; // 60s
let orphanReconcileInFlight = false;

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
  engineFlags: { skipPrepare?: true };
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
  applyChainedRunEngineFlags: (runId: string, flags: { skipPrepare?: true }) => void;
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
  ) => Promise<void>;
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

export async function recoverActiveRuns(deps: RunRecoveryCollaborators): Promise<void> {
  const { runs: active } = deps.listRuns({ active: true });
  if (active.length === 0) return;

  const fleet = await deps.loadFleetStatus();
  console.log(`[run-engine] recovering ${active.length} active run(s)`);

  for (const run of active) {
    if (isLeakedGatewayTestRun(run)) {
      console.warn(
        `[run-engine] skipping recovery for leaked gateway test run ${run.id.slice(0, 8)}`,
      );
      await deps.quarantineLeakedRun(run);
      continue;
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
                d.payload = {
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
                deps.updateRun(run.id, { decisions: run.decisions });
                console.log(`[run-engine] backfilled review payload for ${run.id.slice(0, 8)}`);
              }
            } catch (err) {
              console.warn(
                `[run-engine] failed to backfill blocked review payload for ${run.id.slice(0, 8)}: ${(err as Error).message.slice(0, 200)}`,
              );
            }
          }
        }
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — blocked with ${unresolved.length} unresolved decision(s), re-presenting`,
        );
        for (const d of unresolved) {
          deps.broadcast(Events.RUN_DECISION_NEW, {
            runId: run.id,
            decision: d,
            slotId: run.slotId,
          });
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
              (d.resolvedAction === 'dispatch-merge-main' ||
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
            (d.resolvedAction === 'dispatch-merge-main' ||
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
        if (slot.agent === 'working') {
          console.log(
            `[run-engine] run ${run.id.slice(0, 8)} — worker still active, resuming monitor`,
          );
          deps.startRun(run.id).catch((err) => {
            console.error(
              `[run-engine] recovery failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
            );
          });
          continue;
        }
        console.log(
          `[run-engine] run ${run.id.slice(0, 8)} — worker finished (agent=${slot.agent}), advancing to complete`,
        );
        deps.updateRunStep(run.id, S.MONITOR, {
          status: 'done',
          completedAt: new Date().toISOString(),
        });
        deps.updateRun(run.id, { status: 'completing' });
        deps.updateRunStep(run.id, S.COMPLETE, {
          status: 'running',
          startedAt: new Date().toISOString(),
        });
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
            try {
              await deps.clearStalePrepareProcess(vars, pidPath, 'recovery', cleanupPatterns);
            } catch (cleanupErr) {
              console.warn(
                `[run-engine] run ${run.id.slice(0, 8)} — stale process cleanup failed: ${(cleanupErr as Error).message}, orphaned processes may still be running`,
              );
            }
            const healthHook = pv
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
  const activeSlotIds = new Set(
    active
      .filter((r) => r.status !== 'failed' && r.status !== 'done')
      .map((r) => r.slotId)
      .filter(Boolean),
  );
  const freshFleet = await deps.loadFleetStatus(true);
  for (const slot of freshFleet.slots) {
    if (['busy', 'held'].includes(slot.lifecycle) && !activeSlotIds.has(slot.slot)) {
      console.log(
        `[run-engine] reconcile: orphaned ${slot.slot} (${slot.lifecycle}/${slot.phase}) → ready`,
      );
      await deps.resetSlot(slot.slot);
    }
  }
}
