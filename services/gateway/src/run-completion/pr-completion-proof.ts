import {
  Events,
  gateReasonsForAction,
  isTerminalRunStatus,
  type PRCompletionProofIdentity,
  type Run,
} from '@farmslot/protocol';

import { readSlotField } from '../core/state.js';
import { readPRCompletionHead } from '../review/acceptance-coverage.js';
import { collectRunGateReadiness, RunGateNotReadyError } from '../run-engine/gate-prerequisites.js';
import { reconcileRunPosture } from '../run-engine/resource-posture.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { getRun, persistRunNow, updateRun, updateRunStep } from '../runs/store.js';

import { assertOutputOverrideSnapshot, captureRunOutput, verifyRunOutputReview } from './output.js';

type Emit = (event: string, payload: unknown) => void;

export interface PRCompletionTransactionIdentity extends PRCompletionProofIdentity {
  generation: number;
}

export function completionProofMatches(run: Run, proof: PRCompletionProofIdentity): boolean {
  return (
    run.flowType === 'pr-complete' &&
    run.acceptanceContractVersion === 1 &&
    (run.acceptanceRegistration?.revision ?? 0) === proof.registrationRevision &&
    run.acceptanceExecutionContract?.revision === proof.contractRevision
  );
}

export async function assertPRCompletionIdentity(
  runId: string,
  expected: PRCompletionTransactionIdentity,
): Promise<void> {
  const run = getRun(runId);
  if (
    !run ||
    isTerminalRunStatus(run.status) ||
    run.status === 'paused' ||
    (run.engineState?.generation ?? 0) !== expected.generation ||
    !completionProofMatches(run, expected) ||
    run.acceptanceRegistration?.units.some(({ result }) => !result) ||
    (await readPRCompletionHead(run)) !== expected.headSha ||
    !getRun(runId) ||
    isTerminalRunStatus(getRun(runId)!.status) ||
    getRun(runId)!.status === 'paused' ||
    (getRun(runId)!.engineState?.generation ?? 0) !== expected.generation ||
    !completionProofMatches(getRun(runId)!, expected)
  )
    throw new Error(
      'PR completion acceptance or pushed head changed; settle the current criteria before completing',
    );
}

/** Runs after the conditional REVIEW and before COMPLETE has any PR side effects. */
export async function preparePRCompletionProofHold(
  runId: string,
  emit: Emit,
  expectedGeneration: number,
): Promise<boolean> {
  const first = getRun(runId);
  if (
    first?.flowType !== 'pr-complete' ||
    first.acceptanceContractVersion !== 1 ||
    !first.acceptanceExecutionContract?.claimReviewGate
  )
    return false;
  const held = await withRunTransition(runId, async () => {
    const run = getRun(runId)!;
    if (
      (run.engineState?.generation ?? 0) !== expectedGeneration ||
      run.status !== 'completing' ||
      run.acceptanceRegistration?.units.some(({ result }) => !result)
    )
      return false;
    const slotId = run.slotId;
    const generation = run.engineState?.generation ?? 0;
    if (
      !slotId ||
      isTerminalRunStatus(run.status) ||
      (await readSlotField(slotId, 'current_run_id')) !== runId
    )
      throw new Error('PR completion proof no longer owns its slot');
    const proof: PRCompletionProofIdentity = {
      registrationRevision: run.acceptanceRegistration?.revision ?? 0,
      contractRevision: run.acceptanceExecutionContract!.revision,
      headSha: await readPRCompletionHead(run),
    };
    if (!completionProofMatches(run, proof)) throw new Error('PR completion inputs changed');
    const prior = run.acceptanceProofHold;
    if (
      prior?.state === 'reviewed' &&
      prior.headSha === proof.headSha &&
      completionProofMatches(run, prior)
    )
      return false;
    updateRun(runId, {
      acceptanceProofHold: { ...proof, state: 'held', workerOutcome: run.metrics.outcome },
    });
    await captureRunOutput(runId, true, true);
    const captured = getRun(runId)!;
    if (
      (captured.engineState?.generation ?? 0) !== generation ||
      !completionProofMatches(captured, proof) ||
      (await readSlotField(slotId, 'current_run_id')) !== runId
    )
      throw new Error('PR completion proof changed during capture');
    const decision = captured.decisions.find(
      (entry) =>
        !entry.resolvedAt &&
        entry.payload?.kind === 'output-review' &&
        entry.payload.completionProof?.headSha === proof.headSha,
    );
    if (!decision) throw new Error('PR completion proof has no captured output-review decision');
    updateRunStep(runId, 'complete', {
      status: 'pending',
      detail: 'Awaiting captured visual claim review',
      outputs: { proofHoldDecisionId: decision.id },
    });
    const held = updateRun(runId, {
      status: 'paused',
      acceptanceProofHold: { ...captured.acceptanceProofHold!, decisionId: decision.id },
      metrics: {
        ...captured.metrics,
        outcome: captured.metrics.outcome === 'failure' ? 'failure' : 'partial',
      },
    });
    await persistRunNow(held, 'PR completion held for captured claim review');
    emit(Events.RUN_UPDATED, { run: held });
    return true;
  });
  if (held) await reconcileRunPosture({ runId, boundary: 'operator-wait' });
  return held;
}

/** Only this proof hold turns acknowledgement into a supported COMPLETE continuation. */
export async function acknowledgePRCompletionProof(
  runId: string,
  decisionId: string,
  expected: string,
  emit: Emit,
): Promise<Run> {
  const { continuePRCompletionStep } = await import('../methods/run/replay-step.js');
  const result = await continuePRCompletionStep(runId, 'complete', emit, async () => {
    const before = getRun(runId)!;
    assertOutputOverrideSnapshot(before, decisionId, expected);
    const decision = before.decisions.find(({ id }) => id === decisionId);
    const proof =
      decision?.payload?.kind === 'output-review' ? decision.payload.completionProof : undefined;
    if (
      !proof ||
      !completionProofMatches(before, proof) ||
      before.acceptanceProofHold?.decisionId !== decisionId
    )
      throw new Error('PR completion registration or proof hold changed; refresh the current gate');
    if (
      decision?.resolvedAction === 'mark-reviewed' &&
      before.acceptanceProofHold?.state === 'reviewed' &&
      (before.acceptanceProofHold.resumedGeneration !== undefined || before.status !== 'paused')
    )
      return false;
    const current = await verifyRunOutputReview(runId, decisionId, true, expected);
    if (
      !current.slotId ||
      isTerminalRunStatus(current.status) ||
      (await readSlotField(current.slotId, 'current_run_id')) !== runId ||
      (await readPRCompletionHead(current)) !== proof.headSha
    )
      throw new Error('The captured completion proof no longer matches the owned pushed PR head');
    const readiness = await collectRunGateReadiness(current, null, {}, 'completion-proof');
    const reasons = gateReasonsForAction(readiness, 'complete');
    if (reasons.length || readiness.state !== 'ready')
      throw new RunGateNotReadyError(readiness, reasons);
    const latest = getRun(runId)!;
    assertOutputOverrideSnapshot(latest, decisionId, expected);
    if (
      !completionProofMatches(latest, proof) ||
      (await readPRCompletionHead(latest)) !== proof.headSha
    )
      throw new Error('PR completion inputs changed while proof was reviewed');
    const updated = updateRun(runId, {
      acceptanceProofHold: { ...latest.acceptanceProofHold!, state: 'reviewed' },
      metrics: { ...latest.metrics, outcome: latest.acceptanceProofHold?.workerOutcome },
      decisions: latest.decisions.map((entry) =>
        entry.id === decisionId
          ? {
              ...entry,
              resolvedAt: new Date().toISOString(),
              resolvedAction: 'mark-reviewed',
            }
          : entry,
      ),
    });
    await persistRunNow(updated, 'captured PR completion proof reviewed');
    return true;
  });
  return result.run;
}
