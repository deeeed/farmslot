import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Methods,
  postureForGateChoice,
  RESOURCE_POSTURE_GATE_CHOICES,
  RESOURCE_POSTURE_WAIT_POLICIES,
  RESOURCE_POSTURES,
  type ResourcePostureCapabilityState,
  resourcePostureCounts,
  type ResourcePosturePlan,
  type ResourcePostureRejection,
  resourcePostureRowStatus,
  type ResourcePostureTransition,
  resourcePostureTransitionFailuresToShow,
  type ResourcePostureWaitPolicy,
  type RunResourcePostureState,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityReleaseParams,
  type RuntimePostureApplyParams,
  RuntimePostureMethods,
} from '../src/index.js';

test('posture methods use the shared protocol registry', () => {
  assert.deepEqual(RuntimePostureMethods, {
    status: 'runtime.posture.status',
    preview: 'runtime.posture.preview',
    apply: 'runtime.posture.apply',
  });
  assert.equal(Methods.RUNTIME_POSTURE_APPLY, RuntimePostureMethods.apply);
});

test('postures, gate choices, and wait policies are the ADR-054 vocabulary', () => {
  assert.deepEqual([...RESOURCE_POSTURES], ['active', 'operator-wait', 'parked', 'terminal']);
  assert.deepEqual(
    [...RESOURCE_POSTURE_GATE_CHOICES],
    ['keep-for-validation', 'minimize', 'free-slot', 'project-default'],
  );
  // A preset that defers to the lower precedence levels is a no-op.
  assert.ok(!RESOURCE_POSTURE_WAIT_POLICIES.includes('project-default' as never));
  assert.equal(postureForGateChoice('keep-for-validation'), 'active');
  assert.equal(postureForGateChoice('minimize'), 'operator-wait');
  assert.equal(postureForGateChoice('free-slot'), 'parked');
});

test('capability state separates desired disposition from observed provider state', () => {
  const state: RunResourcePostureState = {
    posture: 'operator-wait',
    policySource: 'gate-choice',
    gateChoice: 'minimize',
    waitPolicy: 'minimize',
    workerRetained: true,
    updatedAt: '2026-09-04T00:00:00.000Z',
    capabilities: [
      {
        capabilityId: 'metro',
        desiredDisposition: 'warm',
        // Released lease, provider still live until the deadline: not `stopped`.
        observedState: 'running',
        policySource: 'project-default',
        reason: 'project retention warm at operator-wait',
        leaseId: 'cap-1',
        owner: { runId: 'run-1', familyId: 'fam-1' },
        warmUntil: '2026-09-04T00:10:00.000Z',
        releaseEffects: ['stop metro bundler'],
      },
      {
        capabilityId: 'simulator',
        desiredDisposition: 'stopped',
        observedState: 'unhealthy',
        policySource: 'framework-default',
        reason: 'high-cost provider not needed while waiting',
        releaseEffects: ['shutdown simulator'],
        cleanupFailure: 'shutdown action exited 1',
      },
    ],
  };
  assert.equal(state.capabilities[0].desiredDisposition, 'warm');
  assert.equal(state.capabilities[0].observedState, 'running');
  assert.equal(state.capabilities[1].cleanupFailure, 'shutdown action exited 1');
});

test('plan, transition, and rejection shapes compose without private copies', () => {
  const plan: ResourcePosturePlan = {
    runId: 'run-1',
    slotId: 'macwork-ff-1',
    posture: 'terminal',
    policySource: 'framework-default',
    reason: 'terminal cleanup stops every run-owned provider',
    acquire: [],
    retain: [],
    warm: [],
    stop: [],
    effects: ['stop metro bundler'],
  };
  const rejection: ResourcePostureRejection = {
    kind: 'park-ineligible',
    code: 'STATUS_NOT_ELIGIBLE',
    reason: "status 'human-gating' is not monitoring or ci-watching",
  };
  const transition: ResourcePostureTransition = {
    id: 'op-1',
    posture: 'parked',
    policySource: 'gate-choice',
    gateChoice: 'free-slot',
    requestedAt: '2026-09-04T00:00:00.000Z',
    completedAt: '2026-09-04T00:00:01.000Z',
    outcome: 'rejected',
    effects: [],
    progress: { total: 0, completed: 0 },
    failures: [],
    rejection,
  };
  assert.equal(plan.posture, 'terminal');
  assert.equal(transition.outcome, 'rejected');
  assert.equal(transition.rejection?.kind, 'park-ineligible');
});

test('apply params carry an idempotency key and an optional proof-plan override', () => {
  const params: RuntimePostureApplyParams = {
    runId: 'run-1',
    posture: 'active',
    gateChoice: 'keep-for-validation',
    operationId: 'op-1',
    proofRequirements: [
      { capabilityId: 'browser-cdp', reason: 'validation rerun', mode: 'visual' },
    ],
  };
  assert.equal(params.proofRequirements?.[0].capabilityId, 'browser-cdp');
});

test('provider retention and release keepWarm ride the existing capability contracts', () => {
  const entry: RuntimeCapabilityCatalogEntry = {
    id: 'metro',
    project: 'farmslot-farm',
    label: 'Metro',
    version: '1',
    sharePolicy: 'exclusive',
    cost: { class: 'high', resources: [{ id: 'metro-port', access: 'exclusive', kind: 'port' }] },
    actions: {
      acquire: { kind: 'resource', resourceId: 'metro', action: 'boot' },
      health: { kind: 'resource', resourceId: 'metro', action: 'health' },
      release: { kind: 'resource', resourceId: 'metro', action: 'shutdown' },
    },
    releaseEffects: ['stop metro bundler'],
    keepWarmMs: 600_000,
    retention: { 'operator-wait': 'warm', terminal: 'stop' },
    provenance: { project: 'farmslot-farm', providerId: 'metro', version: '1', digest: 'abc' },
    availability: { state: 'available' },
  };
  const release: RuntimeCapabilityReleaseParams = {
    slotId: 'macwork-ff-1',
    ownerRunId: 'run-1',
    capabilityId: 'metro',
    keepWarm: false,
  };
  assert.equal(entry.retention?.['operator-wait'], 'warm');
  // `force` still means "bypass the provenance guard"; stopping is its own flag.
  assert.equal(release.force, undefined);
  assert.equal(release.keepWarm, false);
});

test('wait policy is assignable from the gate-choice vocabulary minus project-default', () => {
  const policy: ResourcePostureWaitPolicy = 'free-slot';
  assert.ok(RESOURCE_POSTURE_GATE_CHOICES.includes(policy));
});

test('row status never claims an outcome the Gateway did not observe', () => {
  assert.equal(resourcePostureRowStatus('acquired', 'running'), 'matches');
  assert.equal(resourcePostureRowStatus('warm', 'running'), 'matches');
  assert.equal(resourcePostureRowStatus('stopped', 'stopped'), 'matches');
  assert.equal(resourcePostureRowStatus('stopped', 'running'), 'mismatch');
  assert.equal(resourcePostureRowStatus('acquired', 'stopped'), 'mismatch');
  // A transition in flight is not yet a mismatch.
  assert.equal(resourcePostureRowStatus('stopped', 'transitioning'), 'pending');
  // An unseen provider is neither a match nor a mismatch.
  assert.equal(resourcePostureRowStatus('acquired', 'unknown'), 'unproven');
  assert.equal(resourcePostureRowStatus('stopped', 'unknown'), 'unproven');
});

test('counts report observed state, so an unstopped or failed provider is never counted stopped', () => {
  const capability = (
    overrides: Partial<ResourcePostureCapabilityState>,
  ): ResourcePostureCapabilityState => ({
    capabilityId: 'cap',
    desiredDisposition: 'stopped',
    observedState: 'stopped',
    policySource: 'framework-default',
    reason: 'terminal cleanup',
    releaseEffects: [],
    ...overrides,
  });
  const counts = resourcePostureCounts(
    [
      capability({ capabilityId: 'a', desiredDisposition: 'acquired', observedState: 'running' }),
      capability({ capabilityId: 'b', desiredDisposition: 'warm', observedState: 'running' }),
      capability({ capabilityId: 'c' }),
      // Told to stop, still running: neither retained nor stopped.
      capability({ capabilityId: 'd', observedState: 'running' }),
      // Cleanup failed: a failure and nothing else.
      capability({ capabilityId: 'e', cleanupFailure: 'stop exited 1' }),
      capability({ capabilityId: 'f', observedState: 'unhealthy' }),
      capability({ capabilityId: 'g', observedState: 'unknown' }),
    ],
    undefined,
  );
  assert.deepEqual(counts, { retained: 1, warm: 1, stopped: 1, failed: 2, unresolved: 2 });

  // A transition failure disqualifies a capability from every other bucket even
  // when its own entry looks clean.
  const withTransitionFailure = resourcePostureCounts([capability({ capabilityId: 'a' })], {
    id: 'op-1',
    posture: 'terminal',
    policySource: 'framework-default',
    requestedAt: '2026-09-05T00:00:00.000Z',
    outcome: 'partial',
    effects: [],
    progress: { total: 1, completed: 0 },
    failures: [{ capabilityId: 'a', reason: 'stop exited 1' }],
  });
  assert.deepEqual(withTransitionFailure, {
    retained: 0,
    warm: 0,
    stopped: 0,
    failed: 1,
    unresolved: 0,
  });
});

test('transition failures already carried by a capability are not reported twice', () => {
  const transition: ResourcePostureTransition = {
    id: 'op-1',
    posture: 'terminal',
    policySource: 'framework-default',
    requestedAt: '2026-09-05T00:00:00.000Z',
    outcome: 'partial',
    effects: [],
    progress: { total: 2, completed: 1 },
    failures: [
      { capabilityId: 'metro', reason: 'stop timed out' },
      { capabilityId: 'metro', leaseId: 'lease-9', reason: 'port still bound' },
      { capabilityId: 'chrome', reason: 'no such process' },
    ],
  };
  const remaining = resourcePostureTransitionFailuresToShow(
    [
      { capabilityId: 'metro', cleanupFailure: 'stop timed out' },
      { capabilityId: 'chrome', cleanupFailure: undefined },
    ],
    transition,
  );
  // The sibling lease failed for a different reason, so it is still the only
  // place that failure is reported.
  assert.deepEqual(remaining, [
    { capabilityId: 'metro', leaseId: 'lease-9', reason: 'port still bound' },
    { capabilityId: 'chrome', reason: 'no such process' },
  ]);
  assert.deepEqual(resourcePostureTransitionFailuresToShow([], undefined), []);
});
