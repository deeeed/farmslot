import {
  canActivateRunOnSlot,
  Events,
  FLOW_STEPS,
  PipelineSteps,
  type RunActivateOnSlotParams,
  type RunActivateOnSlotResult,
  type RunAutoRecoveryStopParams,
  type RunAutoRecoveryStopResult,
  type RunCIWatchPokeParams,
  type RunCIWatchPokeResult,
  type RunRefreshMirrorParams,
  type RunRefreshMirrorResult,
  type RunRefreshPublishPackageParams,
  type RunRefreshPublishPackageResult,
  type RunRefreshReviewGateParams,
  type RunRefreshReviewGateResult,
} from '@farmslot/protocol';

import { pokeCIPoll } from '../../ci-monitor/service.js';
import { updateSlotStatus } from '../../core/index.js';
import { loadFleetStatus } from '../../fleet/state.js';
import { refreshArtifactMirror } from '../../run-completion/artifact-mirror.js';
import { refreshPublishPackage } from '../../run-engine/publish-package-refresh.js';
import { refreshReviewGate } from '../../run-engine/review-gate.js';
import { getRun, updateRun } from '../../runs/store.js';

import { runReplayStep } from './replay-step.js';

type Emit = (event: string, payload: unknown) => void;

export function runAutoRecoveryStop(
  params: RunAutoRecoveryStopParams,
  emit: Emit,
): RunAutoRecoveryStopResult {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const updated = updateRun(params.runId, {
    autoRecoveryDisabled: true,
    recoveryProposal: { status: 'disabled', generation: run.engineState?.generation ?? 0 },
  });
  emit(Events.RUN_UPDATED, { run: updated });
  return { run: updated };
}

export function runCIWatchPoke(params: RunCIWatchPokeParams): RunCIWatchPokeResult {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const res = pokeCIPoll(params.runId);
  if (!res.ok) return { ok: false, reason: res.reason ?? 'poke failed' };
  return { ok: true, woken: res.woken === true };
}

export async function runRefreshReviewGate(
  params: RunRefreshReviewGateParams,
  _emit: Emit,
): Promise<RunRefreshReviewGateResult> {
  const run = await refreshReviewGate(params.runId);
  return { run };
}

export async function runRefreshPublishPackage(
  params: RunRefreshPublishPackageParams,
  _emit: Emit,
): Promise<RunRefreshPublishPackageResult> {
  return refreshPublishPackage(params);
}

export async function runRefreshMirror(
  params: RunRefreshMirrorParams,
  _emit: Emit,
): Promise<RunRefreshMirrorResult> {
  const run = getRun(params.runId);
  if (!run) return { ok: false, reason: `Run not found: ${params.runId}` };
  if (!run.slotId) return { ok: false, reason: 'Run not attached to a slot' };
  try {
    const copied = await refreshArtifactMirror(run);
    return { ok: true, copied };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Re-bind an existing run onto a slot and re-drive PREPARE→DISPATCH with the
 * cheapest warm prepare profile (ADR-024 Activate-on-Slot addendum). Lets the
 * operator switch between hot runs across slots without a fresh `run.create`.
 */
export async function runActivateOnSlot(
  params: RunActivateOnSlotParams,
  emit: Emit,
): Promise<RunActivateOnSlotResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);

  // Activate re-drives from PREPARE; flows without a PREPARE step (e.g. merge-main)
  // have no prepare step object to replay and cannot be re-bound this way.
  if (!FLOW_STEPS[run.flowType]?.includes(PipelineSteps.PREPARE)) {
    throw new Error(
      `Cannot activate run ${params.runId.slice(0, 8)}: flow '${run.flowType}' has no PREPARE step.`,
    );
  }

  // Only terminal/blocked runs are re-bindable — re-driving an active run would
  // kill its live worker mid-task.
  if (!canActivateRunOnSlot(run.status)) {
    throw new Error(
      `Run ${params.runId.slice(0, 8)} is currently ${run.status}; wait for it to finish or cancel it before activating it on a slot.`,
    );
  }

  const targetSlot = params.slotId?.trim() || run.slotId;
  if (!targetSlot) {
    throw new Error(
      `Cannot activate run ${params.runId.slice(0, 8)}: no target slot. Pass slotId, or activate a run that already has one.`,
    );
  }

  // Artifact-only/comparison work branches are kept local-only (start-ref-policy), so
  // they can only be re-activated on their origin slot until portable replay deltas
  // land (ADR-030 follow-up #8).
  if (run.completionPolicy === 'artifact-only' && targetSlot !== run.slotId) {
    throw new Error(
      `Run ${params.runId.slice(0, 8)} is artifact-only (local-only branch); activating it on a different slot is not supported yet. Re-activate on its origin slot ${run.slotId ?? '(none)'}.`,
    );
  }

  const slot = (await loadFleetStatus()).slots.find((s) => s.slot === targetSlot);
  if (!slot) throw new Error(`Slot not found: ${targetSlot}`);
  if (slot.agent === 'working' && slot.currentRunId && slot.currentRunId !== run.id) {
    throw new Error(
      `Slot ${targetSlot} is actively running ${slot.currentRunId.slice(0, 8)}; release it or pick another slot before activating ${run.id.slice(0, 8)}.`,
    );
  }

  // Operator-authorized re-bind: claim the slot for this run so the replay re-claim
  // (replaySlotReclaimCheck owner===runId) passes. The prior run is left untouched —
  // its monitor owns its own lifecycle (ADR-024 §7 nudge precedent).
  // Operator-authorized re-bind: claim the slot for this run so the replay re-claim
  // (replaySlotReclaimCheck owner===runId) passes. The prior run is left untouched —
  // its monitor owns its own lifecycle (ADR-024 §7 nudge precedent).
  const priorRunId = slot.currentRunId ?? null;
  const priorSlotId = run.slotId;
  console.log(
    `[run] activate-on-slot slot=${targetSlot} reassigning current_run_id ${
      priorRunId ? priorRunId.slice(0, 8) : '-'
    } -> ${run.id.slice(0, 8)} (operator-approved)`,
  );
  await updateSlotStatus(targetSlot, { current_run_id: run.id });
  updateRun(params.runId, { slotId: targetSlot });

  // Re-drive PREPARE→DISPATCH for the existing run with the cheapest warm profile.
  // runReplayStep persists prepareProfile, re-claims the slot, resets PREPARE-onward,
  // and re-enters the engine; `attach` falls back to the project warm default (ADR-037).
  // It can throw synchronously (ticket validation, step-not-found, slot reclaim) — roll
  // back the operator re-bind so a failed activate never strands the slot assigned to a
  // run that never re-drove.
  try {
    return await runReplayStep(
      {
        runId: params.runId,
        stepName: PipelineSteps.PREPARE,
        prepareProfile: params.prepareProfile ?? 'attach',
        triggeredBy: 'operator',
      },
      emit,
    );
  } catch (err) {
    await updateSlotStatus(targetSlot, { current_run_id: priorRunId });
    updateRun(params.runId, { slotId: priorSlotId });
    throw err;
  }
}
