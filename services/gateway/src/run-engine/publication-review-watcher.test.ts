import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setImmediate as flushed } from 'node:timers/promises';

// HUMAN_GATE holds on the operator's answer until the test releases it.
let releaseGate = () => {};
const heldGateResult = { inputs: {}, outputs: { skipped: true } };
let gateEntered = 0;
let parkOnGateDecision = false;
// Registered before anything loads the real module: it imports the engine back, which would bind
// the real step first. Only HUMAN_GATE runs here; the other steps must not.
const unexpectedStep = () => {
  throw new Error('Only HUMAN_GATE runs in these tests');
};
mock.module('./post-dispatch-steps.js', {
  namedExports: {
    holdInteractiveCompletionForOperator: unexpectedStep,
    persistedUpdateBranchNeedsReview: unexpectedStep,
    shouldSkipRetrospectiveAtComplete: unexpectedStep,
    reconcilePublishGateReviewPlanResult: unexpectedStep,
    readyGateReviewSubjectMatches: unexpectedStep,
    baseReviewPolicy: unexpectedStep,
    executeMonitorStep: unexpectedStep,
    executeReviewStep: unexpectedStep,
    holdSlotForPublicationGate: unexpectedStep,
    rerunReviewIfReviewedInputsChanged: unexpectedStep,
    isFlowTerminalStep: unexpectedStep,
    executeCompleteStep: unexpectedStep,
    executeHumanGateStep: async (runId: string) => {
      gateEntered += 1;
      if (parkOnGateDecision) {
        // The loop presents its gate and waits on the operator, as HUMAN_GATE does.
        await createEngineDecision(runId, 'engine_human_gate', 'Approve publication', [
          { id: 'approve', label: 'Approve', style: 'primary' },
        ]);
        return heldGateResult;
      }
      return new Promise<typeof heldGateResult>((resolve) => {
        releaseGate = () => resolve(heldGateResult);
      });
    },
  },
});
const replayStep = await import('../methods/run/replay-step.js');
const replays: string[] = [];
mock.module('../methods/run/replay-step.js', {
  namedExports: {
    ...replayStep,
    runReplayStep: async (params: { runId: string }) => {
      replays.push(params.runId);
    },
  },
});
const { rearmPublicationReviewRecoveryForRun, startRun, suspendPublicationReviewRecoveryForRun } =
  await import('./orchestrator.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { createEngineDecision, resolveEngineDecision } = await import('./engine-decisions.js');

/** A run whose HUMAN_GATE is still preparing its decision on a slot. */
function preparingGate(): string {
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}${replays.length}`,
    slotId: 'watcher-slot',
  });
  updateRun(created.id, {
    status: 'human-gating',
    steps: created.steps.map((step) =>
      step.name === 'human-gate'
        ? { ...step, status: 'running', detail: 'Preparing operator decision' }
        : step.name === 'finalize' || step.name === 'ci-watch'
          ? step
          : { ...step, status: 'done' },
    ),
    engineState: { ...created.engineState, generation: 3 },
  });
  return created.id;
}

// F311: recovery's replay was refused (the node was still away) and re-armed this retry. An
// operator then replayed the gate and its card came up before the retry fired; the retry must not
// replay again and supersede that card.
test('a pending gate retry stands down once another replay owns the gate (F311)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const untouched = preparingGate();
  const replayedByOperator = preparingGate();
  t.after(async () => {
    for (const id of [untouched, replayedByOperator]) {
      suspendPublicationReviewRecoveryForRun(id);
      updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });
  assert.ok(rearmPublicationReviewRecoveryForRun(untouched, { replayPending: true }));
  assert.ok(rearmPublicationReviewRecoveryForRun(replayedByOperator, { replayPending: true }));
  updateRun(replayedByOperator, {
    engineState: { ...getRun(replayedByOperator)?.engineState, generation: 4 },
  });

  t.mock.timers.tick(60_000);
  // The retry lands after a lazy module import, which takes real time: wait for it with a
  // wall-clock ceiling (the mocked timers leave performance.now real). The moved gate stands down
  // synchronously inside tick(), which the recovery-record assertion below checks.
  const deadline = performance.now() + 5_000;
  while (replays.length === 0 && performance.now() < deadline) await flushed();

  assert.deepEqual(replays, [untouched], 'only the gate nobody else replayed is retried');
  assert.equal(getRun(replayedByOperator)?.engineState?.publishGate?.reviewRecovery, undefined);
});

// Run 5d598e4a (audiolab #495): the gateway restarted with a fix pass active, so recovery owed a
// gate replay. The operator answered the gate with Request review during startup; the answer
// resumed HUMAN_GATE in the same generation and started that review. The owed replay then fired,
// took the gate (gen 3 -> 4) and aborted the requested review. The answer may land before or after
// recovery arms the watcher.
for (const answered of ['before', 'after'] as const) {
  test(`a pending gate retry stands down while the operator's answer drives the gate (${answered} arming)`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const runId = preparingGate();
    t.after(async () => {
      releaseGate();
      suspendPublicationReviewRecoveryForRun(runId);
      updateRun(runId, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(runId);
    });
    const before = replays.length;
    const entered = gateEntered;
    const answer = () => void startRun(runId);
    if (answered === 'before') answer();
    assert.ok(rearmPublicationReviewRecoveryForRun(runId, { replayPending: true }));
    if (answered === 'after') answer();
    const engaged = performance.now() + 2_000;
    while (gateEntered === entered && performance.now() < engaged) await flushed();
    assert.equal(gateEntered, entered + 1, 'the answer resumed HUMAN_GATE');

    t.mock.timers.tick(60_000);
    const deadline = performance.now() + 2_000;
    while (replays.length === before && performance.now() < deadline) await flushed();

    assert.deepEqual(replays.slice(before), [], 'the gate the answer drives is not replayed');
    assert.equal(getRun(runId)?.engineState?.publishGate?.reviewRecovery, undefined);
  });
}

// A loop parked on its own open gate decision is not working the gate: when recovery ingests a
// late reviewer result for it (index.ts re-arms on a terminal reviewer's newer signal), only the
// replay re-presents that gate with the result.
test('a gate replay still runs for a loop parked on its open gate decision', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const runId = preparingGate();
  parkOnGateDecision = true;
  t.after(async () => {
    parkOnGateDecision = false;
    for (const decision of getRun(runId)?.decisions ?? [])
      resolveEngineDecision(decision.id, 'approve');
    suspendPublicationReviewRecoveryForRun(runId);
    updateRun(runId, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(runId);
  });
  const before = replays.length;
  void startRun(runId);
  const parked = performance.now() + 2_000;
  while (
    !getRun(runId)?.decisions.some((decision) => !decision.resolvedAt) &&
    performance.now() < parked
  )
    await flushed();
  assert.ok(
    getRun(runId)?.decisions.some((decision) => !decision.resolvedAt),
    'the loop presented its gate',
  );
  assert.ok(rearmPublicationReviewRecoveryForRun(runId, { replayPending: true }));

  t.mock.timers.tick(60_000);
  const deadline = performance.now() + 5_000;
  while (replays.length === before && performance.now() < deadline) await flushed();

  assert.deepEqual(replays.slice(before), [runId], 'the parked gate is replayed');
});
