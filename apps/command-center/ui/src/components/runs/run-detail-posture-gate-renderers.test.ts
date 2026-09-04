import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESOURCE_POSTURE_GATE_CHOICES,
  type ResourcePostureCapabilityState,
  type ResourcePosturePlan,
} from '@farmslot/protocol';

import {
  canResolveWithPostureChoice,
  gateChoiceHelp,
  gateChoiceLabel,
  postureGatePreviewLines,
  postureGatePreviewSummary,
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
  const rejected = canResolveWithPostureChoice({
    choice: 'free-slot',
    status: 'ready',
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
  assert.equal(canResolveWithPostureChoice({ choice: 'minimize', status: 'loading' }), false);
  assert.equal(
    canResolveWithPostureChoice({ choice: 'minimize', status: 'error', message: 'boom' }),
    false,
  );
  assert.equal(
    canResolveWithPostureChoice({ choice: 'minimize', status: 'ready', plan: plan() }),
    true,
  );
});

test('no chosen posture leaves the gate resolvable exactly as before', () => {
  // Posture is additive: an operator who ignores it must still be able to
  // resolve the decision.
  assert.equal(canResolveWithPostureChoice({ choice: null, status: 'idle' }), true);
});
