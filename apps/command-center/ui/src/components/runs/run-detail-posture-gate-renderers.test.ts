import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESOURCE_POSTURE_GATE_CHOICES,
  type ResourcePostureCapabilityState,
  type ResourcePosturePlan,
  type Run,
} from '@farmslot/protocol';

import {
  canResolveWithPostureChoice,
  gateChoiceHelp,
  gateChoiceLabel,
  pendingDecisionKey,
  postureChoiceBecameInapplicable,
  postureChoiceForResolve,
  postureChoiceHonored,
  postureChoicesApply,
  postureChoiceWithheldReason,
  postureGatePreviewLines,
  postureGatePreviewSummary,
  postureResolveBlockReason,
  RUN_POSTURE_GATE_CHOICES,
} from './run-detail-posture-gate-renderers.js';

function capability(capabilityId: string, reason: string): ResourcePostureCapabilityState {
  return {
    capabilityId,
    desiredDisposition: 'stopped',
    observedState: 'running',
    policySource: 'gate-choice',
    reason,
    releaseEffects: [],
  };
}

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

test('all four gate choices from the protocol are offered, with no client-invented fifth', () => {
  assert.deepEqual([...RUN_POSTURE_GATE_CHOICES], [...RESOURCE_POSTURE_GATE_CHOICES]);
  assert.equal(RUN_POSTURE_GATE_CHOICES.length, 4);
  for (const choice of RUN_POSTURE_GATE_CHOICES) {
    assert.ok(gateChoiceLabel(choice).length > 0, `${choice} needs a label`);
    assert.ok(gateChoiceHelp(choice).length > 0, `${choice} needs help copy`);
  }
});

test('preview lines follow the Gateway plan in acquire, retain, warm, stop order', () => {
  const lines = postureGatePreviewLines(
    plan({
      acquire: [capability('browser-cdp', 'validation proof plan')],
      retain: [capability('sandbox-gateway-ui', 'control plane stays up')],
      warm: [capability('companion-metro', 'reusable within keep-warm')],
      stop: [capability('ios-simulator', 'high cost at operator wait')],
    }),
  );

  assert.deepEqual(
    lines.map((line) => `${line.action}:${line.capabilityId}`),
    [
      'acquire:browser-cdp',
      'retain:sandbox-gateway-ui',
      'warm:companion-metro',
      'stop:ios-simulator',
    ],
  );
  assert.equal(lines[0]?.reason, 'validation proof plan');
});

test('a plan that changes nothing says so instead of rendering as unknown', () => {
  assert.match(postureGatePreviewSummary(plan()), /no capability changes/);
  assert.match(
    postureGatePreviewSummary(
      plan({ stop: [capability('metro', 'shed at wait')], policySource: 'project-default' }),
    ),
    /Operator wait via project default — 1 stopped/,
  );
});

test('a previewed rejection blocks resolution instead of sending a refused choice', () => {
  // The gate is on screen, which is the only situation where a block is honest:
  // the operator can see the refusal and clear the choice.
  const rejected = canResolveWithPostureChoice({
    choice: 'free-slot',
    status: 'ready',
    runPosture: 'operator-wait',
    plan: plan({
      posture: 'parked',
      rejection: {
        kind: 'park-ineligible',
        code: 'gate-held-worker',
        reason: 'gate-held runs are not park eligible',
      },
    }),
  });

  assert.equal(rejected, false);
});

test('resolution is blocked while a chosen preview is still loading or failed', () => {
  const atGate = { runPosture: 'operator-wait' } as const;
  assert.equal(
    canResolveWithPostureChoice({ ...atGate, choice: 'minimize', status: 'loading' }),
    false,
  );
  assert.equal(
    canResolveWithPostureChoice({
      ...atGate,
      choice: 'minimize',
      status: 'error',
      message: 'boom',
    }),
    false,
  );
  assert.equal(
    canResolveWithPostureChoice({ ...atGate, choice: 'minimize', status: 'ready', plan: plan() }),
    true,
  );
});

test('no chosen posture leaves the gate resolvable exactly as before', () => {
  // Posture is additive: an operator who ignores it must still be able to
  // resolve the decision.
  assert.equal(
    canResolveWithPostureChoice({ choice: null, status: 'idle', runPosture: 'operator-wait' }),
    true,
  );
});

function decision(id: string, resolvedAt?: string): Run['decisions'][number] {
  return {
    id,
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Finish in the slot, then resume.',
    actions: [],
    createdAt: '2026-09-05T10:00:00.000Z',
    ...(resolvedAt ? { resolvedAt } : {}),
  };
}

function runWith(decisions: Run['decisions']): Pick<Run, 'id' | 'decisions'> {
  return { id: 'run-1', decisions };
}

test('the gate key changes when a new decision replaces a resolved one on the same run', () => {
  // The stale-preview bug: the run id never changes, so a run-keyed reset alone
  // leaves the previous gate's plan rendered beside the new decision.
  const first = pendingDecisionKey(runWith([decision('gate-a')]));
  const afterResolve = pendingDecisionKey(
    runWith([decision('gate-a', '2026-09-05T11:00:00.000Z'), decision('gate-b')]),
  );

  assert.notEqual(first, afterResolve);
  assert.equal(first, 'run-1:gate-a');
  assert.equal(afterResolve, 'run-1:gate-b');
});

test('the gate key ignores decision order and resolved decisions', () => {
  assert.equal(
    pendingDecisionKey(runWith([decision('b'), decision('a')])),
    pendingDecisionKey(runWith([decision('a'), decision('b')])),
  );
  assert.equal(pendingDecisionKey(runWith([decision('a', '2026-09-05T11:00:00.000Z')])), 'run-1:');
  assert.equal(pendingDecisionKey(null), '');
});

test('a failed preview request and a Gateway rejection give different guidance', () => {
  const failed = postureResolveBlockReason({
    choice: 'minimize',
    status: 'error',
    runPosture: 'operator-wait',
    message: 'gateway RPC timeout after 15000ms',
  });
  const rejected = postureResolveBlockReason({
    choice: 'free-slot',
    status: 'ready',
    runPosture: 'operator-wait',
    plan: plan({
      posture: 'parked',
      rejection: {
        kind: 'park-ineligible',
        code: 'STATUS_NOT_ELIGIBLE',
        reason: "status 'blocked' is not monitoring or ci-watching",
      },
    }),
  });

  assert.match(failed ?? '', /preview request failed/);
  assert.match(failed ?? '', /Retry it/);
  assert.match(failed ?? '', /gateway RPC timeout after 15000ms/);
  assert.doesNotMatch(failed ?? '', /rejected/);

  assert.match(rejected ?? '', /rejected this choice/);
  assert.match(rejected ?? '', /STATUS_NOT_ELIGIBLE/);
  assert.doesNotMatch(rejected ?? '', /request failed/);
});

test('nothing blocks resolution when no choice is selected or the plan is clean', () => {
  // Both state the gate is on screen, or they would pass because the choices are
  // unavailable rather than because nothing is wrong with the choice.
  assert.equal(
    postureResolveBlockReason({ choice: null, status: 'idle', runPosture: 'operator-wait' }),
    null,
  );
  assert.equal(
    postureResolveBlockReason({
      choice: 'minimize',
      status: 'ready',
      runPosture: 'operator-wait',
      plan: plan(),
    }),
    null,
  );
});

test('choices are offered only where the Gateway would honour them', () => {
  // The Gateway resolves a gate choice into a posture only while the run's
  // persisted posture is operator-wait; anywhere else the choice is ignored.
  assert.equal(postureChoicesApply('operator-wait'), true);
  assert.equal(postureChoicesApply('active'), false);
  assert.equal(postureChoicesApply('terminal'), false);
  assert.equal(postureChoicesApply('parked'), false);
  assert.equal(postureChoicesApply(undefined), false);
});

test('an unknown posture offers no choices, so none can be sent before it is known', () => {
  // `undefined` means the posture has not been read yet, never that the run is
  // outside an operator wait — either way nothing is offered.
  assert.equal(postureChoicesApply(undefined), false);
});

test('a plan the Gateway did not resolve from the choice is reported as such', () => {
  // A run whose posture is not operator-wait gets the lifecycle-boundary plan
  // back; presenting it as the effect of the clicked choice would be a lie.
  assert.equal(postureChoiceHonored(plan({ policySource: 'gate-choice' }), 'minimize'), true);
  assert.equal(
    postureChoiceHonored(
      plan({ posture: 'active', policySource: 'framework-default' }),
      'minimize',
    ),
    false,
  );
});

test('project-default is honoured by the Gateway deferring, not by a gate-choice source', () => {
  // The Gateway drops `project-default` before picking a policy source, so it
  // answers from run-dispatch, the project, or the framework. Each of those IS
  // the requested outcome; warning about them would flag the one choice whose
  // entire meaning is to defer.
  for (const source of ['run-dispatch', 'project-default', 'framework-default'] as const) {
    assert.equal(
      postureChoiceHonored(plan({ policySource: source }), 'project-default'),
      true,
      `${source} is what project-default asks for`,
    );
    // The same plan under any other choice is still reported as not honoured.
    assert.equal(postureChoiceHonored(plan({ policySource: source }), 'minimize'), false);
  }
  // A plan resolved from some earlier gate choice is not what project-default
  // asked for, so it is still reported.
  assert.equal(
    postureChoiceHonored(plan({ policySource: 'gate-choice' }), 'project-default'),
    false,
  );
});

test('a project-default choice ignored because the run left operator-wait is reported', () => {
  // The run moves on before the preview executes. The Gateway then answers from
  // the new lifecycle boundary and still reports framework-default, so the
  // policy source alone cannot tell this apart from an honoured deferral. The
  // plan's posture can: it describes the boundary, not the wait.
  for (const posture of ['active', 'terminal', 'parked'] as const) {
    assert.equal(
      postureChoiceHonored(plan({ posture, policySource: 'framework-default' }), 'project-default'),
      false,
      `${posture} is a lifecycle boundary, not the operator wait the choice was made at`,
    );
    assert.equal(
      postureChoiceHonored(plan({ posture, policySource: 'project-default' }), 'project-default'),
      false,
    );
  }
  // Still at the wait, so deferring really did produce this plan.
  assert.equal(
    postureChoiceHonored(
      plan({ posture: 'operator-wait', policySource: 'framework-default' }),
      'project-default',
    ),
    true,
  );
  // A dispatch preset is the run's own wait policy applying, which is exactly
  // what project-default defers to, so its resolved posture may be any of them.
  for (const posture of ['active', 'operator-wait', 'parked'] as const) {
    assert.equal(
      postureChoiceHonored(plan({ posture, policySource: 'run-dispatch' }), 'project-default'),
      true,
      `run-dispatch resolved ${posture} from the wait policy the choice defers to`,
    );
  }
});

test('a rejected plan is summarised as a refusal, not as a harmless no-op', () => {
  const rejected = plan({
    posture: 'parked',
    rejection: {
      kind: 'park-ineligible',
      code: 'STATUS_NOT_ELIGIBLE',
      reason: "status 'blocked' is not monitoring or ci-watching",
    },
  });
  // Both a rejection and an empty plan have no groups; only one is safe to resolve.
  assert.match(postureGatePreviewSummary(rejected), /nothing applied/);
  assert.doesNotMatch(postureGatePreviewSummary(rejected), /no capability changes/);
  assert.match(postureGatePreviewSummary(plan()), /no capability changes/);
});

test('a held choice is dropped once the Gateway moves the run out of operator-wait', () => {
  const held = {
    choice: 'free-slot',
    status: 'ready',
    plan: plan({
      posture: 'parked',
      rejection: { kind: 'park-ineligible', code: 'X', reason: 'not eligible' },
    }),
  } as const;
  // Still at the wait: the choice is the operator's to keep or clear.
  assert.equal(postureChoiceBecameInapplicable({ ...held, runPosture: 'operator-wait' }), false);
  // The Gateway moved on, so the panel hides while this selection would linger
  // and keep blocking Resolve.
  for (const runPosture of ['active', 'terminal', 'parked'] as const) {
    assert.equal(
      postureChoiceBecameInapplicable({ ...held, runPosture }),
      true,
      `${runPosture} no longer honours a gate choice`,
    );
  }
  // An unread posture proves nothing, so nothing is dropped.
  assert.equal(postureChoiceBecameInapplicable(held), false);
  // Nothing held, nothing to drop.
  assert.equal(
    postureChoiceBecameInapplicable({ choice: null, status: 'idle', runPosture: 'active' }),
    false,
  );
});

test('a choice is forwarded only where the Gateway would honour it', () => {
  const refused = {
    choice: 'free-slot',
    status: 'ready',
    plan: plan({
      posture: 'parked',
      rejection: { kind: 'park-ineligible', code: 'STATUS_NOT_ELIGIBLE', reason: 'not eligible' },
    }),
  } as const;

  // At the wait the operator can see and clear the refusal, so the block guards
  // it and the choice is still what would be sent.
  assert.equal(postureChoiceForResolve({ ...refused, runPosture: 'operator-wait' }), 'free-slot');
  assert.equal(canResolveWithPostureChoice({ ...refused, runPosture: 'operator-wait' }), false);

  // Posture unread after a failed status refresh: the panel is hidden and the
  // block lifts, so the forwarding guard is the only thing standing between a
  // refused choice and a consumed decision.
  assert.equal(postureChoiceForResolve({ ...refused, runPosture: undefined }), undefined);
  assert.equal(canResolveWithPostureChoice({ ...refused, runPosture: undefined }), true);
  assert.match(
    postureChoiceWithheldReason({ ...refused, runPosture: undefined }) ?? '',
    /posture is unknown.*withheld/i,
  );

  // The run left the wait: same rule, different wording.
  for (const runPosture of ['active', 'terminal', 'parked'] as const) {
    assert.equal(postureChoiceForResolve({ ...refused, runPosture }), undefined);
    assert.match(
      postureChoiceWithheldReason({ ...refused, runPosture }) ?? '',
      /no longer at an operator wait.*withheld/i,
    );
  }

  // Nothing selected, nothing withheld and nothing to forward.
  assert.equal(
    postureChoiceForResolve({ choice: null, status: 'idle', runPosture: 'operator-wait' }),
    undefined,
  );
  assert.equal(
    postureChoiceWithheldReason({ choice: null, status: 'idle', runPosture: undefined }),
    null,
  );
  // An honoured choice at a wait is forwarded and nothing is withheld.
  const honoured = { choice: 'minimize', status: 'ready', runPosture: 'operator-wait' } as const;
  assert.equal(postureChoiceForResolve(honoured), 'minimize');
  assert.equal(postureChoiceWithheldReason(honoured), null);
});
