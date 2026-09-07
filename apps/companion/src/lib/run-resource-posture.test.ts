import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ResourcePostureCapabilityState,
  ResourcePostureTransition,
  RunResourcePostureState,
} from '@farmslot/protocol';

import {
  postureAfterPausedRefresh,
  postureCapabilityRow,
  postureCountsLine,
  posturePolicyLine,
  postureRowStatusLabel,
  postureTransitionLine,
  postureWhileRefreshing,
  rejectionMessage,
  resourceWaitLine,
  type RunPostureStatusState,
  summarizeRunPosture,
} from './run-resource-posture';

function capability(
  overrides: Partial<ResourcePostureCapabilityState> & { capabilityId: string },
): ResourcePostureCapabilityState {
  return {
    desiredDisposition: 'acquired',
    observedState: 'running',
    policySource: 'framework-default',
    reason: 'required by the current proof plan',
    releaseEffects: [],
    ...overrides,
  };
}

function postureState(overrides: Partial<RunResourcePostureState> = {}): RunResourcePostureState {
  return {
    posture: 'operator-wait',
    policySource: 'gate-choice',
    capabilities: [],
    workerRetained: true,
    updatedAt: '2026-09-04T10:00:00.000Z',
    ...overrides,
  };
}

function transition(overrides: Partial<ResourcePostureTransition> = {}): ResourcePostureTransition {
  return {
    id: 'op-1',
    posture: 'operator-wait',
    policySource: 'gate-choice',
    requestedAt: '2026-09-04T09:59:00.000Z',
    completedAt: '2026-09-04T10:00:00.000Z',
    outcome: 'applied',
    effects: [],
    progress: { total: 3, completed: 3 },
    failures: [],
    ...overrides,
  };
}

test('summary reports retained, warm, and stopped from what was observed', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({ capabilityId: 'worker', desiredDisposition: 'acquired' }),
        capability({
          capabilityId: 'metro',
          desiredDisposition: 'warm',
          observedState: 'running',
          warmUntil: '2026-09-04T10:30:00.000Z',
        }),
        capability({
          capabilityId: 'chrome',
          desiredDisposition: 'stopped',
          observedState: 'stopped',
        }),
      ],
    }),
  );
  assert.deepEqual(summary.counts, { retained: 1, warm: 1, stopped: 1, failed: 0, unresolved: 0 });
  assert.equal(postureCountsLine(summary.counts), '1 retained · 1 warm · 1 stopped · 0 failed');
  assert.equal(summary.rows.length, 3);
  assert.equal(summary.rows[1]?.desiredLabel, 'warm');
  assert.equal(summary.rows[1]?.warmUntil, '2026-09-04T10:30:00.000Z');
});

test('a provider the Gateway meant to stop but which is still running is never counted stopped', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          capabilityId: 'simulator',
          desiredDisposition: 'stopped',
          observedState: 'running',
          reason: 'released for the wait',
        }),
      ],
    }),
  );
  assert.equal(summary.counts.stopped, 0);
  assert.equal(summary.counts.unresolved, 1);
  assert.equal(summary.rows[0]?.rowStatus, 'mismatch');
  assert.equal(summary.rows[0]?.rowStatusLabel, 'does not match intent');
  assert.equal(
    postureCountsLine(summary.counts),
    '0 retained · 0 warm · 0 stopped · 0 failed · 1 unresolved',
  );
});

test('the counts line hides the unresolved bucket only when it is empty', () => {
  assert.equal(
    postureCountsLine({ retained: 2, warm: 0, stopped: 3, failed: 1, unresolved: 0 }),
    '2 retained · 0 warm · 3 stopped · 1 failed',
  );
  assert.equal(
    postureCountsLine({ retained: 2, warm: 0, stopped: 3, failed: 1, unresolved: 4 }),
    '2 retained · 0 warm · 3 stopped · 1 failed · 4 unresolved',
  );
});

test('a transition failure counts as failed even when the capability row looks clean', () => {
  const clean = postureState({
    capabilities: [
      capability({
        capabilityId: 'metro',
        desiredDisposition: 'stopped',
        observedState: 'stopped',
      }),
    ],
  });
  assert.equal(summarizeRunPosture(clean).counts.stopped, 1);
  // The same rows with a failed transition must not still read as stopped: the
  // summary has to hand the transition to the shared count derivation.
  const withFailure = summarizeRunPosture({
    ...clean,
    lastTransition: transition({
      outcome: 'partial',
      failures: [{ capabilityId: 'metro', reason: 'stop command exited 1' }],
    }),
  });
  assert.equal(withFailure.counts.failed, 1);
  assert.equal(withFailure.counts.stopped, 0);
});

test('row status labels name the disagreement instead of a bare state word', () => {
  assert.equal(postureRowStatusLabel('matches'), 'as intended');
  assert.equal(postureRowStatusLabel('mismatch'), 'does not match intent');
  assert.equal(postureRowStatusLabel('pending'), 'transition in flight');
  assert.equal(postureRowStatusLabel('unproven'), 'not observed');
});

test('an unobserved provider is labelled not observed rather than claimed either way', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          capabilityId: 'webpack',
          desiredDisposition: 'stopped',
          observedState: 'unknown',
        }),
      ],
    }),
  );
  assert.equal(summary.rows[0]?.rowStatus, 'unproven');
  assert.equal(summary.rows[0]?.rowStatusLabel, 'not observed');
  assert.equal(summary.counts.stopped, 0);
  assert.equal(summary.counts.unresolved, 1);
});

test('policy line names the winning source with the choice and dispatch preset behind it', () => {
  const summary = summarizeRunPosture(
    postureState({ policySource: 'gate-choice', gateChoice: 'minimize', waitPolicy: 'free-slot' }),
  );
  assert.equal(
    posturePolicyLine(summary),
    'policy from operator gate choice · choice minimize · dispatch preset free-slot',
  );
  assert.equal(
    posturePolicyLine(summarizeRunPosture(postureState({ policySource: 'framework-default' }))),
    'policy from framework default',
  );
});

test('transition line reports the outcome and progress rather than a bare status', () => {
  assert.equal(
    postureTransitionLine(
      transition({ posture: 'terminal', outcome: 'partial', progress: { total: 4, completed: 2 } }),
    ),
    'Last transition to Terminal: partially applied · 2/4 steps',
  );
  assert.equal(
    postureTransitionLine(transition({ outcome: 'idempotent' })),
    'Last transition to Operator wait: no change needed · 3/3 steps',
  );
});

test('a failure already on a row is not repeated, but a sibling lease failure is', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          capabilityId: 'metro',
          desiredDisposition: 'stopped',
          observedState: 'unknown',
          cleanupFailure: 'stop command exited 1',
        }),
      ],
      lastTransition: transition({
        outcome: 'partial',
        failures: [
          { capabilityId: 'metro', leaseId: 'lease-a', reason: 'stop command exited 1' },
          { capabilityId: 'metro', leaseId: 'lease-b', reason: 'pid 1234 survived SIGTERM' },
          { capabilityId: 'chrome', reason: 'provider unreachable' },
        ],
      }),
    }),
  );
  assert.deepEqual(
    summary.unreportedFailures.map((failure) => failure.reason),
    ['pid 1234 survived SIGTERM', 'provider unreachable'],
  );
});

test('a park-ineligible rejection is stated with its Gateway code, not as a generic failure', () => {
  assert.equal(
    rejectionMessage({
      kind: 'park-ineligible',
      code: 'gate-held',
      reason: 'the run holds a worker at a human gate',
    }),
    'Rejected — the run cannot be parked (gate-held): the run holds a worker at a human gate',
  );
});

test('a run holding nothing summarizes as zero rather than as unknown', () => {
  const summary = summarizeRunPosture(postureState({ posture: 'terminal', capabilities: [] }));
  assert.equal(summary.rows.length, 0);
  assert.equal(postureCountsLine(summary.counts), '0 retained · 0 warm · 0 stopped · 0 failed');
  assert.equal(summary.postureLabel, 'Terminal');
});

test('a refresh of the same run keeps its counts on screen', () => {
  const ready: RunPostureStatusState = {
    status: 'ready',
    slotId: 'macpro-ff-1',
    state: postureState({ capabilities: [capability({ capabilityId: 'metro' })] }),
  };
  const refreshing = postureWhileRefreshing(ready, true);
  assert.equal(refreshing.status, 'loading');
  assert.equal(refreshing.state?.capabilities.length, 1);
  assert.equal(refreshing.slotId, 'macpro-ff-1');
});

test('switching run or connection drops the previous counts instead of relabelling them', () => {
  const ready: RunPostureStatusState = {
    status: 'ready',
    slotId: 'macpro-ff-1',
    state: postureState({ capabilities: [capability({ capabilityId: 'metro' })] }),
  };
  const switched = postureWhileRefreshing(ready, false);
  assert.deepEqual(switched, { status: 'loading' });
});

test('a paused refresh cannot mark another run counts ready', () => {
  const ready: RunPostureStatusState = {
    status: 'ready',
    state: postureState({ capabilities: [capability({ capabilityId: 'metro' })] }),
  };
  // Same run: the last reading is still the Gateway's answer for it.
  assert.equal(postureAfterPausedRefresh(postureWhileRefreshing(ready, true)).status, 'ready');
  // Different run: nothing was retained, so there is nothing to call ready.
  assert.deepEqual(postureAfterPausedRefresh(postureWhileRefreshing(ready, false)), {
    status: 'idle',
  });
});

test('the resolved device target reaches the Companion row from the lease', () => {
  const plain = postureCapabilityRow(capability({ capabilityId: 'browser-cdp' }));
  assert.equal(plain.targetLabel, undefined);

  const retargeted = postureCapabilityRow(
    capability({ capabilityId: 'ios-simulator', target: { platform: 'ios', simulator: 'SIM-2' } }),
  );
  assert.equal(retargeted.targetLabel, 'platform=ios, simulator=SIM-2');

  const summary = summarizeRunPosture(
    postureState({
      capabilities: [capability({ capabilityId: 'ios-simulator', target: { simulator: 'SIM-2' } })],
    }),
  );
  assert.equal(summary.rows[0]?.targetLabel, 'simulator=SIM-2');
});

test('a scoped resource wait reaches the Companion summary in one compact line', () => {
  const wait = {
    capabilityId: 'recording',
    claimId: 'capture-helper',
    scope: 'fleet' as const,
    phase: 'queued' as const,
    blockingOwner: { runId: 'run-holder' },
    queuedLeaseId: 'cap-queued',
    position: 2,
    since: '2026-09-05T10:01:00.000Z',
    reason: "Resource 'capture-helper' is claimed at fleet scope",
  };
  const summary = summarizeRunPosture(postureState({ resourceWait: wait }));
  assert.deepEqual(summary.resourceWait, wait);
  assert.match(
    resourceWaitLine(wait),
    /Waiting for recording · position 2 for 'capture-helper' \(fleet\) · held by run-holder/,
  );
  assert.equal(summarizeRunPosture(postureState()).resourceWait, undefined);
});

test('Companion says granted rather than reporting a queue place that is over', () => {
  const granted = {
    capabilityId: 'recording',
    claimId: 'capture-helper',
    scope: 'fleet' as const,
    phase: 'granted' as const,
    blockingOwner: { runId: 'run-holder' },
    queuedLeaseId: 'cap-queued',
    position: 0,
    since: '2026-09-05T10:01:00.000Z',
    reason: "Resource 'capture-helper' is reserved for this run",
  };
  assert.match(resourceWaitLine(granted), /Granted recording/);
  assert.doesNotMatch(resourceWaitLine(granted), /position/);
});
