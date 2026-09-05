import assert from 'node:assert/strict';
import test from 'node:test';

import {
  correlateResourcePostureTransition,
  isTerminalResourcePostureOutcome,
  type ResourcePosturePlan,
  type ResourcePostureTransition,
  resourcePostureTransitionBaseline,
  resourcePostureTransitions,
  type RunResourcePostureState,
} from '@farmslot/protocol';

import {
  canResolveWithPostureChoice,
  gateChoiceHelp,
  gateChoiceLabel,
  initialRunPostureGateState,
  observePostureTransition,
  postureApplyAlert,
  postureChoiceForResolve,
  postureChoiceHonored,
  postureChoicesApply,
  postureChoiceWithheldReason,
  postureGateKey,
  postureGatePreviewLines,
  postureGatePreviewSummary,
  postureResolveBlock,
  RUN_POSTURE_GATE_CHOICES,
  runPostureGateApplied,
  runPostureGateForContext,
  runPostureGatePreviewFailed,
  runPostureGatePreviewLoaded,
  runPostureGateSelect,
} from './run-posture-gate';

function plan(overrides: Partial<ResourcePosturePlan> = {}): ResourcePosturePlan {
  return {
    runId: 'run-1',
    slotId: 'macpro-ff-1',
    posture: 'operator-wait',
    policySource: 'gate-choice',
    reason: 'operator chose minimize',
    acquire: [],
    retain: [],
    warm: [],
    stop: [],
    effects: [],
    ...overrides,
  };
}

const atOperatorWait = { canForwardChoice: true, runPosture: 'operator-wait' } as const;

function capability(capabilityId: string, reason: string) {
  return {
    capabilityId,
    desiredDisposition: 'stopped' as const,
    observedState: 'running' as const,
    policySource: 'gate-choice' as const,
    reason,
    releaseEffects: [],
  };
}

test('all four ADR-054 gate choices are offered, each with operator copy', () => {
  assert.deepEqual(
    [...RUN_POSTURE_GATE_CHOICES],
    ['keep-for-validation', 'minimize', 'free-slot', 'project-default'],
  );
  for (const choice of RUN_POSTURE_GATE_CHOICES) {
    assert.ok(gateChoiceLabel(choice).length > 0, `${choice} has a label`);
    assert.ok(gateChoiceHelp(choice).length > 0, `${choice} has help text`);
  }
});

test('choices are offered only where the Gateway would honour them', () => {
  assert.equal(postureChoicesApply({ canForwardChoice: true, runPosture: 'operator-wait' }), true);
  assert.equal(postureChoicesApply({ canForwardChoice: true, runPosture: 'active' }), false);
  assert.equal(postureChoicesApply({ canForwardChoice: true, runPosture: 'parked' }), false);
  assert.equal(postureChoicesApply({ canForwardChoice: true, runPosture: 'terminal' }), false);
  assert.equal(postureChoicesApply({ canForwardChoice: true, runPosture: undefined }), false);
});

test('the gate key distinguishes two decisions on the same run', () => {
  assert.equal(postureGateKey('run-1', 'decision-a'), 'run-1:decision-a');
  assert.notEqual(postureGateKey('run-1', 'decision-a'), postureGateKey('run-1', 'decision-b'));
  // An incomplete gate identity never matches a real one.
  assert.equal(postureGateKey('run-1', null), '');
  assert.equal(postureGateKey(null, 'decision-a'), '');
  assert.equal(postureGateKey('', ''), '');
});

test('selecting a choice loads a preview and selecting it again clears it', () => {
  const gate = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  const selected = runPostureGateSelect(gate, 'minimize', {
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  assert.equal(selected.choice, 'minimize');
  assert.equal(selected.status, 'loading');
  assert.ok(selected.requestId > gate.requestId);

  const cleared = runPostureGateSelect(selected, 'minimize', {
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  assert.equal(cleared.choice, null);
  assert.equal(cleared.status, 'idle');
  assert.ok(cleared.requestId > selected.requestId);
});

test('a preview that lands after the operator changed choice is discarded', () => {
  const first = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'minimize',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const second = runPostureGateSelect(first, 'keep-for-validation', {
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  const stale = runPostureGatePreviewLoaded(second, {
    gateKey: first.gateKey,
    requestId: first.requestId,
    canForwardChoice: true,
    runPosture: 'operator-wait',
    plan: plan({ reason: 'stale minimize plan' }),
  });
  assert.equal(stale, second);
  assert.equal(stale.plan, undefined);
  assert.equal(stale.status, 'loading');
});

test('a preview that lands after a different gate opened is discarded', () => {
  const onFirstGate = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'minimize',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const onSecondGate = runPostureGateForContext(onFirstGate, {
    gateKey: 'run-1:b',
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  assert.equal(onSecondGate.choice, null);
  const stale = runPostureGatePreviewLoaded(onSecondGate, {
    gateKey: 'run-1:a',
    requestId: onFirstGate.requestId,
    canForwardChoice: true,
    runPosture: 'operator-wait',
    plan: plan(),
  });
  assert.equal(stale.plan, undefined);
});

test('a current preview populates the plan and clears an earlier message', () => {
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'minimize',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const failed = runPostureGatePreviewFailed(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    canForwardChoice: true,
    runPosture: 'operator-wait',
    message: 'socket closed',
  });
  assert.equal(failed.status, 'error');
  assert.equal(postureResolveBlock(failed, atOperatorWait).kind, 'request-failed');
  assert.equal(canResolveWithPostureChoice(failed, atOperatorWait), false);

  const retried = runPostureGateSelect(
    runPostureGateSelect(failed, null, { canForwardChoice: true, runPosture: 'operator-wait' }),
    'minimize',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const ready = runPostureGatePreviewLoaded(retried, {
    gateKey: retried.gateKey,
    requestId: retried.requestId,
    canForwardChoice: true,
    runPosture: 'operator-wait',
    plan: plan({ stop: [capability('metro', 'expensive for a wait')] }),
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.message, undefined);
  assert.equal(canResolveWithPostureChoice(ready, atOperatorWait), true);
});

test('a park-ineligible free-slot preview blocks the choice as rejected, not as a failure', () => {
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'free-slot',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const rejected = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    canForwardChoice: true,
    runPosture: 'operator-wait',
    plan: plan({
      posture: 'parked',
      rejection: {
        kind: 'park-ineligible',
        code: 'gate-held',
        reason: 'the run holds a worker at a human gate',
      },
    }),
  });
  const block = postureResolveBlock(rejected, atOperatorWait);
  assert.equal(block.kind, 'rejected');
  assert.match(block.message, /pick another/);
  assert.match(block.message, /gate-held/);
  assert.equal(canResolveWithPostureChoice(rejected, atOperatorWait), false);
  assert.equal(
    postureChoiceForResolve(rejected, { canForwardChoice: true, runPosture: 'operator-wait' }),
    undefined,
  );
});

test('resolving is blocked while the preview is still in flight', () => {
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'minimize',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  assert.equal(postureResolveBlock(selected, atOperatorWait).kind, 'pending');
  assert.equal(canResolveWithPostureChoice(selected, atOperatorWait), false);
  assert.equal(
    postureChoiceForResolve(selected, { canForwardChoice: true, runPosture: 'operator-wait' }),
    undefined,
  );
});

test('no choice selected is not a block: the run keeps its own policy', () => {
  const gate = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  assert.equal(postureResolveBlock(gate, atOperatorWait).kind, 'none');
  assert.equal(canResolveWithPostureChoice(gate, atOperatorWait), true);
  assert.equal(
    postureChoiceForResolve(gate, { canForwardChoice: true, runPosture: 'operator-wait' }),
    undefined,
  );
});

test('a proven choice is forwarded only while the Gateway is still at an operator wait', () => {
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'minimize',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const ready = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    canForwardChoice: true,
    runPosture: 'operator-wait',
    plan: plan(),
  });
  assert.equal(
    postureChoiceForResolve(ready, { canForwardChoice: true, runPosture: 'operator-wait' }),
    'minimize',
  );
  assert.equal(
    postureChoiceForResolve(ready, { canForwardChoice: true, runPosture: 'active' }),
    undefined,
  );
  assert.equal(
    postureChoiceForResolve(ready, { canForwardChoice: true, runPosture: undefined }),
    undefined,
  );
});

test('a plan the Gateway resolved from another source is not presented as the choice', () => {
  assert.equal(postureChoiceHonored(plan({ policySource: 'gate-choice' }), 'minimize'), true);
  assert.equal(postureChoiceHonored(plan({ policySource: 'project-default' }), 'minimize'), false);
});

test('project-default is honoured precisely when the Gateway deferred to a lower level', () => {
  // Choosing "project default" and being warned that the plan came from the
  // project default would flag the choice as ignored at the moment it was obeyed.
  assert.equal(
    postureChoiceHonored(
      plan({ policySource: 'project-default', posture: 'operator-wait' }),
      'project-default',
    ),
    true,
  );
  assert.equal(
    postureChoiceHonored(
      plan({ policySource: 'framework-default', posture: 'operator-wait' }),
      'project-default',
    ),
    true,
  );
  assert.equal(
    postureChoiceHonored(
      plan({ policySource: 'run-dispatch', posture: 'active' }),
      'project-default',
    ),
    true,
  );
  assert.equal(
    postureChoiceHonored(plan({ policySource: 'gate-choice' }), 'project-default'),
    false,
  );
});

test('preview lines run acquire, retain, warm, stop and summarize the counts', () => {
  const previewed = plan({
    acquire: [capability('simulator', 'validation proof plan')],
    retain: [capability('worker', 'gate-held worker is never stopped')],
    warm: [capability('metro', 'kept warm for the next validation')],
    stop: [capability('chrome', 'expensive for a wait')],
    effects: ['closes the evidence browser'],
  });
  assert.deepEqual(
    postureGatePreviewLines(previewed).map((line) => `${line.action} ${line.capabilityId}`),
    ['acquire simulator', 'retain worker', 'warm metro', 'stop chrome'],
  );
  assert.equal(
    postureGatePreviewSummary(previewed),
    'Operator wait via operator gate choice — 1 to acquire · 1 retained · 1 left warm · 1 stopped',
  );
  assert.equal(
    postureGatePreviewSummary(plan()),
    'Operator wait via operator gate choice — no capability changes',
  );
});

test('a rejected plan says nothing was applied, not that nothing would change', () => {
  const rejected = plan({
    posture: 'parked',
    rejection: { kind: 'park-ineligible', code: 'gate-held', reason: 'gate-held run' },
  });
  assert.equal(
    postureGatePreviewSummary(rejected),
    'Parked via operator gate choice — nothing applied',
  );
});

test('the apply outcome is recorded so a rejection at resolve time stays visible', () => {
  const transition: ResourcePostureTransition = {
    id: 'op-9',
    posture: 'parked',
    policySource: 'gate-choice',
    gateChoice: 'free-slot',
    requestedAt: '2026-09-04T10:00:00.000Z',
    outcome: 'rejected',
    effects: [],
    progress: { total: 0, completed: 0 },
    failures: [],
    rejection: { kind: 'park-ineligible', code: 'gate-held', reason: 'gate-held run' },
  };
  const gate = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  assert.equal(runPostureGateApplied(gate, undefined), gate);
  assert.equal(runPostureGateApplied(gate, transition).appliedTransition?.outcome, 'rejected');
});

test('a choice is never honoured once the run has left the operator wait', () => {
  // The gap the source test alone cannot see: project-default asked the Gateway
  // to defer, the run moved off the wait before the preview ran, and the plan for
  // that boundary is "not gate-choice" like any other. Reporting it as honoured
  // tells the operator their ignored choice took effect. The plan carries the
  // answer, so no cached client posture is consulted: a stale one is exactly how
  // an ignored choice would look honoured.
  for (const posture of ['active', 'terminal', 'parked'] as const) {
    for (const policySource of ['framework-default', 'project-default'] as const) {
      assert.equal(
        postureChoiceHonored(plan({ posture, policySource }), 'project-default'),
        false,
        `${posture}/${policySource} left the wait, so the deferral was not applied`,
      );
    }
  }
  // Still at the wait with nothing lower to defer to: the run's own posture wins.
  assert.equal(
    postureChoiceHonored(
      plan({ posture: 'operator-wait', policySource: 'framework-default' }),
      'project-default',
    ),
    true,
  );
  // A dispatch preset applying IS what deferring means, whichever posture it picks.
  for (const posture of ['active', 'operator-wait', 'parked'] as const) {
    assert.equal(
      postureChoiceHonored(plan({ posture, policySource: 'run-dispatch' }), 'project-default'),
      true,
    );
  }
  // The non-deferring choices resolve to their own postures, so posture is never
  // required of them: keep-for-validation is active and free-slot is parked.
  assert.equal(
    postureChoiceHonored(
      plan({ posture: 'active', policySource: 'gate-choice' }),
      'keep-for-validation',
    ),
    true,
  );
  assert.equal(
    postureChoiceHonored(plan({ posture: 'parked', policySource: 'gate-choice' }), 'free-slot'),
    true,
  );
});

test('a preview answered after the run left the operator wait is discarded', () => {
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'project-default',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const landedTooLate = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    canForwardChoice: true,
    runPosture: 'active',
    plan: plan({ posture: 'active', policySource: 'framework-default' }),
  });
  assert.equal(landedTooLate.plan, undefined);
  assert.equal(landedTooLate.status, 'loading');
  const failedTooLate = runPostureGatePreviewFailed(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    canForwardChoice: true,
    runPosture: 'terminal',
    message: 'socket closed',
  });
  assert.equal(failedTooLate.status, 'loading');
});

test('a choice cannot be selected outside an operator wait', () => {
  const gate = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    canForwardChoice: true,
    runPosture: 'operator-wait',
  });
  const attempted = runPostureGateSelect(gate, 'minimize', {
    canForwardChoice: true,
    runPosture: 'active',
  });
  assert.equal(attempted.choice, null);
  assert.equal(attempted.status, 'idle');
  assert.ok(attempted.requestId > gate.requestId);
});

test('a rejected choice stops blocking once the choices no longer apply', () => {
  // Select free-slot, see the Gateway refuse it, then the run leaves the wait.
  // The choices disappear; leaving the refusal behind would block every action
  // on the decision with a verdict about a choice that no longer has any bearing.
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    'free-slot',
    { canForwardChoice: true, runPosture: 'operator-wait' },
  );
  const rejected = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    canForwardChoice: true,
    runPosture: 'operator-wait',
    plan: plan({
      posture: 'parked',
      rejection: { kind: 'park-ineligible', code: 'gate-held', reason: 'gate-held run' },
    }),
  });
  assert.equal(canResolveWithPostureChoice(rejected, atOperatorWait), false);

  const movedOn = runPostureGateForContext(rejected, {
    gateKey: 'run-1:a',
    canForwardChoice: true,
    runPosture: 'active',
  });
  assert.equal(movedOn.choice, null);
  assert.equal(movedOn.plan, undefined);
  assert.equal(postureResolveBlock(movedOn, atOperatorWait).kind, 'none');
  assert.equal(canResolveWithPostureChoice(movedOn, atOperatorWait), true);
  // The request id moved, so the in-flight preview cannot repopulate it.
  assert.ok(movedOn.requestId > rejected.requestId);
});

test('an applied outcome survives the gate being rebound, since it already happened', () => {
  const applied = runPostureGateApplied(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      canForwardChoice: true,
      runPosture: 'operator-wait',
    }),
    {
      id: 'op-1',
      posture: 'parked',
      policySource: 'gate-choice',
      requestedAt: '2026-09-05T10:00:00.000Z',
      outcome: 'rejected',
      effects: [],
      progress: { total: 0, completed: 0 },
      failures: [],
      rejection: { kind: 'park-ineligible', code: 'gate-held', reason: 'gate-held run' },
    },
  );
  const movedOn = runPostureGateForContext(applied, {
    gateKey: 'run-1:b',
    canForwardChoice: true,
    runPosture: 'active',
  });
  assert.equal(movedOn.appliedTransition?.id, 'op-1');
});

function postureStateWith(transitions: ResourcePostureTransition[]): RunResourcePostureState {
  return {
    posture: 'operator-wait',
    policySource: 'gate-choice',
    capabilities: [],
    workerRetained: true,
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...(transitions[0] ? { lastTransition: transitions[0] } : {}),
    recentTransitions: transitions,
  };
}

function transitionWith(
  id: string,
  overrides: Partial<ResourcePostureTransition> = {},
): ResourcePostureTransition {
  return {
    id,
    posture: 'operator-wait',
    policySource: 'gate-choice',
    requestedAt: '2026-09-05T10:00:00.000Z',
    outcome: 'applied',
    effects: [],
    progress: { total: 1, completed: 1 },
    failures: [],
    ...overrides,
  };
}

test('the transition already on screen before resolving is never reported as the outcome', () => {
  // The dangerous shape: the operator retries the same choice, so the stale
  // transition carries that choice too and only its id can rule it out.
  const before = postureStateWith([
    transitionWith('op-old', {
      outcome: 'rejected',
      gateChoice: 'minimize',
      rejection: { kind: 'invalid-request', reason: 'earlier refusal' },
    }),
  ]);
  const baseline = resourcePostureTransitionBaseline(before, 'minimize');
  // run.resolveDecision returns before reconciliation finishes, so the status
  // still carries only the transition the client already had.
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(before)),
    undefined,
  );
  const after = postureStateWith([
    transitionWith('op-new', { gateChoice: 'minimize' }),
    ...(before.recentTransitions ?? []),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(after))?.id,
    'op-new',
  );
});

test('a record the Gateway attributed to a different choice is not this outcome', () => {
  const baseline = resourcePostureTransitionBaseline(
    postureStateWith([transitionWith('op-old')]),
    'minimize',
  );
  const otherChoice = postureStateWith([
    transitionWith('op-other', { gateChoice: 'keep-for-validation' }),
    transitionWith('op-old'),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(otherChoice)),
    undefined,
  );
});

test('an unattributed record is not excluded, because rejections carry no choice', () => {
  // Rule 3 is conditional. A rejection can legitimately carry no gateChoice, and
  // excluding it strands the one record the operator most needs to see.
  const baseline = resourcePostureTransitionBaseline(
    postureStateWith([transitionWith('op-old')]),
    'free-slot',
  );
  const refused = postureStateWith([
    transitionWith('op-refused', {
      outcome: 'rejected',
      rejection: { kind: 'park-ineligible', code: 'gate-held', reason: 'gate-held run' },
    }),
    transitionWith('op-old'),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(refused))?.id,
    'op-refused',
  );
});

test('a record older than everything already seen cannot be this outcome', () => {
  // Rule 2, entirely in Gateway time: a backfilled or out-of-order record is new
  // to this client but predates the resolution, so a novel id is not enough.
  const baseline = resourcePostureTransitionBaseline(
    postureStateWith([transitionWith('op-old', { requestedAt: '2026-09-05T10:00:00.000Z' })]),
    'minimize',
  );
  assert.equal(baseline.newestRequestedAt, '2026-09-05T10:00:00.000Z');
  const backfilled = postureStateWith([
    transitionWith('op-backfilled', { requestedAt: '2026-09-05T09:59:00.000Z' }),
    transitionWith('op-old', { requestedAt: '2026-09-05T10:00:00.000Z' }),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(backfilled)),
    undefined,
  );
  const afterwards = postureStateWith([
    transitionWith('op-new', { requestedAt: '2026-09-05T10:00:01.000Z' }),
    transitionWith('op-old', { requestedAt: '2026-09-05T10:00:00.000Z' }),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(afterwards))?.id,
    'op-new',
  );
});

test('a run with no prior transitions bounds correlation on id alone', () => {
  const baseline = resourcePostureTransitionBaseline(undefined, 'minimize');
  assert.deepEqual(baseline.transitionIds, []);
  assert.equal(baseline.newestRequestedAt, undefined);
  const first = postureStateWith([transitionWith('op-first', { gateChoice: 'minimize' })]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(first))?.id,
    'op-first',
  );
});

test('the bounded wait reports pending rather than inventing an outcome', async () => {
  const before = postureStateWith([transitionWith('op-old')]);
  const baseline = resourcePostureTransitionBaseline(before, 'minimize');
  let reads = 0;
  const observation = await observePostureTransition(
    baseline,
    async () => {
      reads++;
      return before;
    },
    { attempts: 3, delayMs: 1, wait: async () => {} },
  );
  assert.equal(observation.status, 'pending');
  assert.equal(reads, 3);
  assert.deepEqual(postureApplyAlert(observation, 'minimize'), {
    title: 'Resource posture pending',
    message:
      'The Gateway has not reported the outcome of "Minimize" yet. The run\'s posture summary will show it once reconciliation finishes.',
  });
});

test('the bounded wait returns the correlated transition as soon as it appears', async () => {
  const before = postureStateWith([transitionWith('op-old')]);
  const baseline = resourcePostureTransitionBaseline(before, 'minimize');
  const states = [
    before,
    before,
    postureStateWith([
      transitionWith('op-new', {
        gateChoice: 'minimize',
        outcome: 'partial',
        failures: [{ capabilityId: 'metro', reason: 'stop command exited 1' }],
      }),
      transitionWith('op-old'),
    ]),
  ];
  let reads = 0;
  const observation = await observePostureTransition(
    baseline,
    async () => states[reads++] ?? before,
    { attempts: 5, delayMs: 1, wait: async () => {} },
  );
  assert.equal(observation.status, 'observed');
  assert.equal(reads, 3);
  assert.deepEqual(postureApplyAlert(observation, 'minimize'), {
    title: 'Resource posture partly applied',
    message: 'metro: stop command exited 1',
  });
});

test('an unreadable status is reported, not retried into silence', async () => {
  const baseline = resourcePostureTransitionBaseline(
    postureStateWith([transitionWith('op-old')]),
    'minimize',
  );
  const observation = await observePostureTransition(
    baseline,
    async () => {
      throw new Error('socket closed');
    },
    { attempts: 3, delayMs: 1, wait: async () => {} },
  );
  assert.deepEqual(observation, { status: 'unreadable', message: 'socket closed' });
  assert.equal(postureApplyAlert(observation, 'minimize')?.title, 'Resource posture unknown');
});

test('a clean applied outcome says nothing, so success is not an interruption', () => {
  const observation = {
    status: 'observed' as const,
    transition: transitionWith('op-new', { gateChoice: 'minimize' }),
  };
  assert.equal(postureApplyAlert(observation, 'minimize'), null);
});

test('a deferred project-default resolution still correlates, since the Gateway attributes no choice', () => {
  // `resolveEffectivePosturePolicy` treats project-default as "no explicit
  // choice", so the transition it produces carries no gateChoice. Matching on
  // one would report every deferred resolution as still pending.
  const before = postureStateWith([transitionWith('op-old')]);
  const baseline = resourcePostureTransitionBaseline(before, 'project-default');
  // The choice is kept on the baseline; rule 3 simply never fires for a record
  // that carries none, so project-default is bounded by id and time like the rest.
  assert.equal(baseline.choice, 'project-default');
  const after = postureStateWith([
    transitionWith('op-new', { policySource: 'project-default' }),
    transitionWith('op-old'),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(after))?.id,
    'op-new',
  );
});

test('a decision that cannot carry a choice is never offered one', () => {
  // sourceRunId falls back to context.runId and the route param, so a decision
  // without runMeta still has a run. It resolves through `decision.resolve`,
  // which has no resourcePosture field, so showing the choices would let the
  // operator read a plan that resolving silently discards.
  const atWait = { canForwardChoice: true, runPosture: 'operator-wait' } as const;
  const noRunDecision = { canForwardChoice: false, runPosture: 'operator-wait' } as const;
  assert.equal(postureChoicesApply(atWait), true);
  assert.equal(postureChoicesApply(noRunDecision), false);

  const gate = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    ...noRunDecision,
  });
  const attempted = runPostureGateSelect(gate, 'minimize', noRunDecision);
  assert.equal(attempted.choice, null);
  assert.equal(postureChoiceForResolve(attempted, noRunDecision), undefined);

  // And a choice made while it was deliverable stops being forwarded if it is not.
  const selected = runPostureGateSelect(gate, 'minimize', atWait);
  const ready = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    ...atWait,
    plan: plan(),
  });
  assert.equal(postureChoiceForResolve(ready, atWait), 'minimize');
  assert.equal(postureChoiceForResolve(ready, noRunDecision), undefined);
});

test('two selections in one frame get their own request ids', () => {
  // The screen must derive each selection from the previous one, not from the
  // value it rendered with. Sharing a request id lets the first choice's preview
  // pass the staleness guard and render under the second.
  const availability = { canForwardChoice: true, runPosture: 'operator-wait' } as const;
  const base = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    ...availability,
  });
  const first = runPostureGateSelect(base, 'minimize', availability);
  const fromStaleBase = runPostureGateSelect(base, 'free-slot', availability);
  assert.equal(
    first.requestId,
    fromStaleBase.requestId,
    'deriving both taps from the rendered value collides the ids',
  );

  const second = runPostureGateSelect(first, 'free-slot', availability);
  assert.notEqual(first.requestId, second.requestId);
  // The first choice's preview must not land on the second choice.
  const landed = runPostureGatePreviewLoaded(second, {
    gateKey: second.gateKey,
    requestId: first.requestId,
    ...availability,
    plan: plan({ reason: 'minimize plan' }),
  });
  assert.equal(landed.plan, undefined);
  assert.equal(landed.choice, 'free-slot');
});

test('an unread posture never clears the selection the operator just made', () => {
  // The status has not come back yet, or its refresh failed. That is not
  // evidence the choice stopped applying, and clearing on it would discard a
  // tap the operator made a moment ago while the preview was still in flight.
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      ...atOperatorWait,
    }),
    'minimize',
    atOperatorWait,
  );
  const unknown = { canForwardChoice: true, runPosture: undefined } as const;
  const kept = runPostureGateForContext(selected, { gateKey: 'run-1:a', ...unknown });
  assert.equal(kept, selected);
  assert.equal(kept.choice, 'minimize');
  // Nothing is forwarded while the posture is unknown, so keeping it is safe.
  assert.equal(postureChoiceForResolve(kept, unknown), undefined);
  // A posture that IS known and off the wait still clears.
  const cleared = runPostureGateForContext(selected, {
    gateKey: 'run-1:a',
    canForwardChoice: true,
    runPosture: 'active',
  });
  assert.equal(cleared.choice, null);
});

test('a refusal stops blocking wherever the choices are not offered', () => {
  // Held rejection plus an unreadable status: the panel is hidden and no choice
  // can be forwarded, so standing between the operator and the decision with a
  // verdict about that choice is the same deadlock in a different disguise.
  const selected = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      ...atOperatorWait,
    }),
    'free-slot',
    atOperatorWait,
  );
  const rejected = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    ...atOperatorWait,
    plan: plan({
      posture: 'parked',
      rejection: { kind: 'park-ineligible', code: 'gate-held', reason: 'gate-held run' },
    }),
  });
  assert.equal(postureResolveBlock(rejected, atOperatorWait).kind, 'rejected');
  for (const availability of [
    { canForwardChoice: true, runPosture: undefined },
    { canForwardChoice: false, runPosture: 'operator-wait' },
    { canForwardChoice: true, runPosture: 'active' },
  ] as const) {
    assert.equal(postureResolveBlock(rejected, availability).kind, 'none');
    assert.equal(canResolveWithPostureChoice(rejected, availability), true);
    assert.equal(postureChoiceForResolve(rejected, availability), undefined);
  }
});

test('an in-progress record keeps the wait open until the Gateway finishes', async () => {
  // Returning on in-progress reports a half-finished apply as the result, and
  // the failure that lands a moment later is never seen.
  const before = postureStateWith([transitionWith('op-old')]);
  const baseline = resourcePostureTransitionBaseline(before, 'minimize');
  const states = [
    postureStateWith([
      transitionWith('op-new', { gateChoice: 'minimize', outcome: 'in-progress' }),
      transitionWith('op-old'),
    ]),
    postureStateWith([
      transitionWith('op-new', { gateChoice: 'minimize', outcome: 'in-progress' }),
      transitionWith('op-old'),
    ]),
    postureStateWith([
      transitionWith('op-new', {
        gateChoice: 'minimize',
        outcome: 'partial',
        failures: [{ capabilityId: 'metro', reason: 'stop command exited 1' }],
      }),
      transitionWith('op-old'),
    ]),
  ];
  let reads = 0;
  const observation = await observePostureTransition(baseline, async () => states[reads++]!, {
    attempts: 5,
    delayMs: 1,
    wait: async () => {},
  });
  assert.equal(observation.status, 'observed');
  assert.equal(reads, 3);
  assert.deepEqual(postureApplyAlert(observation, 'minimize'), {
    title: 'Resource posture partly applied',
    message: 'metro: stop command exited 1',
  });
});

test('a wait that ends while still in progress reports pending, never the half-finished record', async () => {
  const before = postureStateWith([transitionWith('op-old')]);
  const baseline = resourcePostureTransitionBaseline(before, 'minimize');
  const stillWorking = postureStateWith([
    transitionWith('op-new', { gateChoice: 'minimize', outcome: 'in-progress' }),
    transitionWith('op-old'),
  ]);
  const observation = await observePostureTransition(baseline, async () => stillWorking, {
    attempts: 3,
    delayMs: 1,
    wait: async () => {},
  });
  assert.equal(observation.status, 'pending');
  assert.equal(postureApplyAlert(observation, 'minimize')?.title, 'Resource posture pending');
});

test('every settled outcome ends the wait', () => {
  assert.equal(isTerminalResourcePostureOutcome('in-progress'), false);
  for (const outcome of ['applied', 'idempotent', 'partial', 'rejected', 'failed'] as const) {
    assert.equal(isTerminalResourcePostureOutcome(outcome), true, `${outcome} settles`);
  }
});

test('a backgrounded app is waited through, not reported as an unknown outcome', async () => {
  // Backgrounding pauses gateway requests routinely. Calling that unknown pops an
  // alarming alert for something normal, so the wait rides it out.
  const before = postureStateWith([transitionWith('op-old')]);
  const baseline = resourcePostureTransitionBaseline(before, 'minimize');
  const paused = new Error('gateway request paused while the app was backgrounded');
  const settled = postureStateWith([
    transitionWith('op-new', { gateChoice: 'minimize' }),
    transitionWith('op-old'),
  ]);
  let reads = 0;
  const observation = await observePostureTransition(
    baseline,
    async () => {
      reads++;
      if (reads < 3) throw paused;
      return settled;
    },
    { attempts: 5, delayMs: 1, wait: async () => {}, isTransient: (err) => err === paused },
  );
  assert.equal(observation.status, 'observed');
  assert.equal(reads, 3);

  // A pause that never lifts is pending, not unknown.
  const neverLifts = await observePostureTransition(
    baseline,
    async () => {
      throw paused;
    },
    { attempts: 3, delayMs: 1, wait: async () => {}, isTransient: (err) => err === paused },
  );
  assert.equal(neverLifts.status, 'pending');

  // A real failure is still reported rather than waited through.
  const broken = await observePostureTransition(
    baseline,
    async () => {
      throw new Error('socket closed');
    },
    { attempts: 3, delayMs: 1, wait: async () => {}, isTransient: (err) => err === paused },
  );
  assert.deepEqual(broken, { status: 'unreadable', message: 'socket closed' });
});

test('an attribution the Gateway made beats a newer unattributed record', () => {
  // Taken from a real run's history: an attributed minimize apply followed by
  // two unattributed reconciliations. Returning the newest survivor reported the
  // wrong one as the operator's outcome.
  const baseline = resourcePostureTransitionBaseline(
    postureStateWith([transitionWith('op-oldest', { requestedAt: '2026-09-05T02:58:15.438Z' })]),
    'minimize',
  );
  const history = postureStateWith([
    transitionWith('op-newest', { requestedAt: '2026-09-05T02:58:18.614Z' }),
    transitionWith('op-middle', { requestedAt: '2026-09-05T02:58:18.022Z' }),
    transitionWith('op-mine', {
      requestedAt: '2026-09-05T02:58:17.547Z',
      gateChoice: 'minimize',
    }),
    transitionWith('op-oldest', { requestedAt: '2026-09-05T02:58:15.438Z' }),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(history))?.id,
    'op-mine',
  );
});

test('with nothing attributed the newest survivor is used, and it is the newest', () => {
  const baseline = resourcePostureTransitionBaseline(
    postureStateWith([transitionWith('op-oldest', { requestedAt: '2026-09-05T02:58:15.438Z' })]),
    'project-default',
  );
  const history = postureStateWith([
    transitionWith('op-newest', { requestedAt: '2026-09-05T02:58:18.614Z' }),
    transitionWith('op-middle', { requestedAt: '2026-09-05T02:58:18.022Z' }),
    transitionWith('op-oldest', { requestedAt: '2026-09-05T02:58:15.438Z' }),
  ]);
  assert.equal(
    correlateResourcePostureTransition(baseline, resourcePostureTransitions(history))?.id,
    'op-newest',
  );
});

test('a selection that will not be forwarded says so instead of vanishing', () => {
  // The round-3 scenario the reviewer described: pick free-slot, the posture
  // read fails, the panel disappears, and the choice is dropped with nothing
  // said. The panel cannot carry this notice, because it returns null in exactly
  // these situations.
  const held = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      ...atOperatorWait,
    }),
    'free-slot',
    atOperatorWait,
  );

  assert.equal(postureChoiceWithheldReason(held, atOperatorWait), null);
  assert.equal(
    postureChoiceWithheldReason(held, { canForwardChoice: true, runPosture: undefined }),
    "Resource posture is unknown, so the Free the slot choice is withheld. Resolving now applies the run's own policy.",
  );
  assert.equal(
    postureChoiceWithheldReason(held, { canForwardChoice: true, runPosture: 'active' }),
    "This run is no longer at an operator wait, so the Free the slot choice is withheld. Resolving now applies the run's own policy.",
  );
  // Companion-only: the decision resolves through decision.resolve, which has no
  // field to carry the choice. A fact about the decision, not a passing state,
  // so it is reported ahead of an unread posture.
  assert.equal(
    postureChoiceWithheldReason(held, { canForwardChoice: false, runPosture: 'operator-wait' }),
    "This decision cannot carry a posture choice, so the Free the slot choice is withheld. Resolving now applies the run's own policy.",
  );
  assert.equal(
    postureChoiceWithheldReason(held, { canForwardChoice: false, runPosture: undefined }),
    "This decision cannot carry a posture choice, so the Free the slot choice is withheld. Resolving now applies the run's own policy.",
  );
});

test('nothing is reported as withheld when no choice is held', () => {
  const empty = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    ...atOperatorWait,
  });
  for (const availability of [
    atOperatorWait,
    { canForwardChoice: true, runPosture: undefined },
    { canForwardChoice: false, runPosture: 'operator-wait' },
    { canForwardChoice: true, runPosture: 'terminal' },
  ] as const) {
    assert.equal(postureChoiceWithheldReason(empty, availability), null);
  }
});

test('a held choice either travels or the operator can read why not', () => {
  // Stated as "exactly one of forwarded and withheld" this is FALSE, and my
  // first version only passed because it used a clean plan. At the gate with a
  // refused plan nothing forwards and nothing is withheld, because the panel is
  // on screen with the rejection: the choice was not dropped in silence, it was
  // refused out loud. So the property worth guarding is that a held choice is
  // either sent, or its absence is readable somewhere.
  const availabilities = [
    atOperatorWait,
    { canForwardChoice: true, runPosture: undefined },
    { canForwardChoice: false, runPosture: 'operator-wait' },
    { canForwardChoice: true, runPosture: 'active' },
    { canForwardChoice: true, runPosture: 'parked' },
  ] as const;
  const held = runPostureGateSelect(
    runPostureGateForContext(initialRunPostureGateState(), {
      gateKey: 'run-1:a',
      ...atOperatorWait,
    }),
    'free-slot',
    atOperatorWait,
  );
  const clean = runPostureGatePreviewLoaded(held, {
    gateKey: held.gateKey,
    requestId: held.requestId,
    ...atOperatorWait,
    plan: plan(),
  });
  const refused = runPostureGatePreviewLoaded(held, {
    gateKey: held.gateKey,
    requestId: held.requestId,
    ...atOperatorWait,
    plan: plan({
      posture: 'parked',
      rejection: { kind: 'park-ineligible', code: 'gate-held', reason: 'gate-held run' },
    }),
  });

  for (const gate of [clean, refused]) {
    for (const availability of availabilities) {
      const forwarded = postureChoiceForResolve(gate, availability);
      const withheld = postureChoiceWithheldReason(gate, availability);
      const blocked = postureResolveBlock(gate, availability).kind !== 'none';
      const where = `${gate.plan?.rejection ? 'refused' : 'clean'} ${JSON.stringify(availability)}`;
      if (forwarded) {
        assert.equal(withheld, null, `claimed withheld while travelling: ${where}`);
        assert.equal(blocked, false, `blocked while travelling: ${where}`);
        continue;
      }
      assert.equal(
        Boolean(withheld) || blocked,
        true,
        `choice dropped with no explanation: ${where}`,
      );
      if (!postureChoicesApply(availability)) {
        // The panel is hidden here, so the notice is the only channel left.
        assert.ok(withheld, `panel hidden and nothing said: ${where}`);
      }
    }
  }
});

test('nothing is claimed about a choice that was never made', () => {
  const empty = runPostureGateForContext(initialRunPostureGateState(), {
    gateKey: 'run-1:a',
    ...atOperatorWait,
  });
  for (const availability of [
    atOperatorWait,
    { canForwardChoice: true, runPosture: undefined },
    { canForwardChoice: false, runPosture: 'operator-wait' },
    { canForwardChoice: true, runPosture: 'terminal' },
  ] as const) {
    assert.equal(postureChoiceForResolve(empty, availability), undefined);
    assert.equal(postureChoiceWithheldReason(empty, availability), null);
    assert.equal(postureResolveBlock(empty, availability).kind, 'none');
  }
});
