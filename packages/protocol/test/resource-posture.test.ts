import assert from 'node:assert/strict';
import test from 'node:test';

import {
  correlateResourcePostureTransition,
  isTerminalResourcePostureOutcome,
  Methods,
  postureForGateChoice,
  RESOURCE_POSTURE_GATE_CHOICES,
  RESOURCE_POSTURE_TERMINAL_OUTCOMES,
  RESOURCE_POSTURE_TRANSITION_OUTCOMES,
  RESOURCE_POSTURE_WAIT_POLICIES,
  RESOURCE_POSTURES,
  type ResourcePostureCapabilityState,
  resourcePostureCounts,
  type ResourcePostureGateChoice,
  type ResourcePosturePlan,
  type ResourcePostureRejection,
  resourcePostureRowStatus,
  type ResourcePostureTransition,
  resourcePostureTransitionBaseline,
  resourcePostureTransitionFailuresToShow,
  type ResourcePostureTransitionOutcome,
  resourcePostureTransitions,
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

test('terminal outcomes are an allowlist, so a new outcome is a wait until considered', () => {
  // `!== 'in-progress'` would make any future outcome terminal on whichever
  // client updated last. Failing towards "keep waiting" is the safe direction.
  assert.equal(isTerminalResourcePostureOutcome('in-progress'), false);
  for (const outcome of ['applied', 'idempotent', 'partial', 'rejected', 'failed'] as const) {
    assert.equal(isTerminalResourcePostureOutcome(outcome), true, `${outcome} ends the wait`);
  }
  assert.equal(
    RESOURCE_POSTURE_TERMINAL_OUTCOMES.length + 1,
    RESOURCE_POSTURE_TRANSITION_OUTCOMES.length,
    'every outcome except in-progress is terminal today',
  );
  // The whole point of the allowlist: an outcome this build has never heard of
  // is a wait until someone considers it. `!== 'in-progress'` would call it
  // terminal and stop polling on a state nobody has reasoned about.
  assert.equal(
    isTerminalResourcePostureOutcome('queued' as ResourcePostureTransitionOutcome),
    false,
  );
});

function correlationRecord(
  id: string,
  requestedAt: string,
  gateChoice?: ResourcePostureGateChoice,
): ResourcePostureTransition {
  return {
    id,
    posture: 'operator-wait',
    policySource: gateChoice ? 'gate-choice' : 'framework-default',
    requestedAt,
    outcome: gateChoice ? 'idempotent' : 'applied',
    effects: [],
    progress: { total: 1, completed: 1 },
    failures: [],
    ...(gateChoice ? { gateChoice } : {}),
  };
}

test('correlation applies novelty, Gateway-time recency, and attribution in one place', () => {
  const seen = correlationRecord('op-0', '2026-09-05T12:00:00.000Z');
  const baseline = resourcePostureTransitionBaseline(
    { recentTransitions: [seen], lastTransition: seen },
    'minimize',
  );

  // 1. Novelty.
  assert.equal(correlateResourcePostureTransition(baseline, [seen]), undefined);
  assert.equal(correlateResourcePostureTransition(baseline, []), undefined);

  // 2. Recency in Gateway time: a backfilled record predating the resolution.
  assert.equal(
    correlateResourcePostureTransition(baseline, [
      correlationRecord('op-old', '2026-09-05T11:59:59.000Z'),
    ]),
    undefined,
  );
  // A tie is kept; novelty already removed the baseline record itself.
  const tie = correlationRecord('op-tie', '2026-09-05T12:00:00.000Z');
  assert.deepEqual(correlateResourcePostureTransition(baseline, [tie]), tie);

  // 3. Attribution: another choice's record is excluded outright.
  assert.equal(
    correlateResourcePostureTransition(baseline, [
      correlationRecord('op-other', '2026-09-05T12:00:02.000Z', 'keep-for-validation'),
    ]),
    undefined,
  );
});

test('an attributed record beats an unattributed one that merely landed later', () => {
  // The real history of run 35c0428c read off the dev gateway, newest first.
  // Taking the newest survivor returns the unattributed reconciliation that
  // landed after the operator's; the Gateway attributed theirs two rows down.
  const history = [
    correlationRecord('posture-d193d148', '2026-09-05T02:58:18.614Z'),
    correlationRecord('posture-6c1f2a87', '2026-09-05T02:58:18.022Z'),
    correlationRecord('posture-1e08ef03', '2026-09-05T02:58:17.547Z', 'minimize'),
    correlationRecord('posture-cbf380af', '2026-09-05T02:58:15.438Z'),
  ];
  const baseline = resourcePostureTransitionBaseline(
    { recentTransitions: [history[3]], lastTransition: history[3] },
    'minimize',
  );
  assert.equal(correlateResourcePostureTransition(baseline, history)?.id, 'posture-1e08ef03');

  // With nothing attributed the newest survivor is the honest fallback, which is
  // what a rejection carrying no choice and a deferred project-default rely on.
  assert.equal(
    correlateResourcePostureTransition(baseline, [history[0], history[1]])?.id,
    'posture-d193d148',
  );
  const deferred = resourcePostureTransitionBaseline(
    { recentTransitions: [history[3]], lastTransition: history[3] },
    'project-default',
  );
  assert.equal(correlateResourcePostureTransition(deferred, history)?.id, 'posture-d193d148');
});

test('the baseline reads the persisted history and falls back to lastTransition', () => {
  const older = correlationRecord('op-a', '2026-09-05T12:00:00.000Z');
  const newer = correlationRecord('op-b', '2026-09-05T12:00:05.000Z');
  const baseline = resourcePostureTransitionBaseline(
    { recentTransitions: [newer, older], lastTransition: newer },
    null,
  );
  assert.deepEqual([...baseline.transitionIds], ['op-b', 'op-a']);
  assert.equal(baseline.newestRequestedAt, '2026-09-05T12:00:05.000Z');

  // A run with no history anchors on nothing, so any record qualifies.
  const empty = resourcePostureTransitionBaseline(undefined, null);
  assert.deepEqual([...empty.transitionIds], []);
  assert.equal(empty.newestRequestedAt, undefined);
  assert.deepEqual(correlateResourcePostureTransition(empty, [older]), older);
  assert.deepEqual(resourcePostureTransitions({ lastTransition: older }), [older]);
});
