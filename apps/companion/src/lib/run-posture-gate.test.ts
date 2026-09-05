import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourcePosturePlan, ResourcePostureTransition } from '@farmslot/protocol';

import {
  canResolveWithPostureChoice,
  gateChoiceHelp,
  gateChoiceLabel,
  initialRunPostureGateState,
  postureChoiceForResolve,
  postureChoiceHonored,
  postureChoicesApply,
  postureGateKey,
  postureGatePreviewLines,
  postureGatePreviewSummary,
  postureResolveBlock,
  RUN_POSTURE_GATE_CHOICES,
  runPostureGateApplied,
  runPostureGateForKey,
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
  assert.equal(postureChoicesApply('operator-wait'), true);
  assert.equal(postureChoicesApply('active'), false);
  assert.equal(postureChoicesApply('parked'), false);
  assert.equal(postureChoicesApply('terminal'), false);
  assert.equal(postureChoicesApply(undefined), false);
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
  const gate = runPostureGateForKey(initialRunPostureGateState(), 'run-1:a');
  const selected = runPostureGateSelect(gate, 'minimize');
  assert.equal(selected.choice, 'minimize');
  assert.equal(selected.status, 'loading');
  assert.ok(selected.requestId > gate.requestId);

  const cleared = runPostureGateSelect(selected, 'minimize');
  assert.equal(cleared.choice, null);
  assert.equal(cleared.status, 'idle');
  assert.ok(cleared.requestId > selected.requestId);
});

test('a preview that lands after the operator changed choice is discarded', () => {
  const first = runPostureGateSelect(
    runPostureGateForKey(initialRunPostureGateState(), 'run-1:a'),
    'minimize',
  );
  const second = runPostureGateSelect(first, 'keep-for-validation');
  const stale = runPostureGatePreviewLoaded(second, {
    gateKey: first.gateKey,
    requestId: first.requestId,
    plan: plan({ reason: 'stale minimize plan' }),
  });
  assert.equal(stale, second);
  assert.equal(stale.plan, undefined);
  assert.equal(stale.status, 'loading');
});

test('a preview that lands after a different gate opened is discarded', () => {
  const onFirstGate = runPostureGateSelect(
    runPostureGateForKey(initialRunPostureGateState(), 'run-1:a'),
    'minimize',
  );
  const onSecondGate = runPostureGateForKey(onFirstGate, 'run-1:b');
  assert.equal(onSecondGate.choice, null);
  const stale = runPostureGatePreviewLoaded(onSecondGate, {
    gateKey: 'run-1:a',
    requestId: onFirstGate.requestId,
    plan: plan(),
  });
  assert.equal(stale.plan, undefined);
});

test('a current preview populates the plan and clears an earlier message', () => {
  const selected = runPostureGateSelect(
    runPostureGateForKey(initialRunPostureGateState(), 'run-1:a'),
    'minimize',
  );
  const failed = runPostureGatePreviewFailed(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    message: 'socket closed',
  });
  assert.equal(failed.status, 'error');
  assert.equal(postureResolveBlock(failed).kind, 'request-failed');
  assert.equal(canResolveWithPostureChoice(failed), false);

  const retried = runPostureGateSelect(runPostureGateSelect(failed, null), 'minimize');
  const ready = runPostureGatePreviewLoaded(retried, {
    gateKey: retried.gateKey,
    requestId: retried.requestId,
    plan: plan({ stop: [capability('metro', 'expensive for a wait')] }),
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.message, undefined);
  assert.equal(canResolveWithPostureChoice(ready), true);
});

test('a park-ineligible free-slot preview blocks the choice as rejected, not as a failure', () => {
  const selected = runPostureGateSelect(
    runPostureGateForKey(initialRunPostureGateState(), 'run-1:a'),
    'free-slot',
  );
  const rejected = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    plan: plan({
      posture: 'parked',
      rejection: {
        kind: 'park-ineligible',
        code: 'gate-held',
        reason: 'the run holds a worker at a human gate',
      },
    }),
  });
  const block = postureResolveBlock(rejected);
  assert.equal(block.kind, 'rejected');
  assert.match(block.message, /pick another/);
  assert.match(block.message, /gate-held/);
  assert.equal(canResolveWithPostureChoice(rejected), false);
  assert.equal(postureChoiceForResolve(rejected, 'operator-wait'), undefined);
});

test('resolving is blocked while the preview is still in flight', () => {
  const selected = runPostureGateSelect(
    runPostureGateForKey(initialRunPostureGateState(), 'run-1:a'),
    'minimize',
  );
  assert.equal(postureResolveBlock(selected).kind, 'pending');
  assert.equal(canResolveWithPostureChoice(selected), false);
  assert.equal(postureChoiceForResolve(selected, 'operator-wait'), undefined);
});

test('no choice selected is not a block: the run keeps its own policy', () => {
  const gate = runPostureGateForKey(initialRunPostureGateState(), 'run-1:a');
  assert.equal(postureResolveBlock(gate).kind, 'none');
  assert.equal(canResolveWithPostureChoice(gate), true);
  assert.equal(postureChoiceForResolve(gate, 'operator-wait'), undefined);
});

test('a proven choice is forwarded only while the Gateway is still at an operator wait', () => {
  const selected = runPostureGateSelect(
    runPostureGateForKey(initialRunPostureGateState(), 'run-1:a'),
    'minimize',
  );
  const ready = runPostureGatePreviewLoaded(selected, {
    gateKey: selected.gateKey,
    requestId: selected.requestId,
    plan: plan(),
  });
  assert.equal(postureChoiceForResolve(ready, 'operator-wait'), 'minimize');
  assert.equal(postureChoiceForResolve(ready, 'active'), undefined);
  assert.equal(postureChoiceForResolve(ready, undefined), undefined);
});

test('a plan the Gateway resolved from another source is not presented as the choice', () => {
  assert.equal(postureChoiceHonored(plan({ policySource: 'gate-choice' }), 'minimize'), true);
  assert.equal(postureChoiceHonored(plan({ policySource: 'project-default' }), 'minimize'), false);
});

test('project-default is honoured precisely when the Gateway deferred to a lower level', () => {
  // Choosing "project default" and being warned that the plan came from the
  // project default would flag the choice as ignored at the moment it was obeyed.
  assert.equal(
    postureChoiceHonored(plan({ policySource: 'project-default' }), 'project-default'),
    true,
  );
  assert.equal(
    postureChoiceHonored(plan({ policySource: 'framework-default' }), 'project-default'),
    true,
  );
  assert.equal(
    postureChoiceHonored(plan({ policySource: 'run-dispatch' }), 'project-default'),
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
  const gate = runPostureGateForKey(initialRunPostureGateState(), 'run-1:a');
  assert.equal(runPostureGateApplied(gate, undefined), gate);
  assert.equal(runPostureGateApplied(gate, transition).appliedTransition?.outcome, 'rejected');
});
