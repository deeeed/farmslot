import assert from 'node:assert/strict';
import test from 'node:test';

import { nothing } from 'lit';

import {
  type ResourcePostureCapabilityState,
  resourcePostureRowStatus,
  type ResourcePostureTransition,
  type RunResourcePostureState,
} from '@farmslot/protocol';

import {
  policySourceLabel,
  postureCapabilityRow,
  postureTransitionFailuresToShow,
  rejectionMessage,
  renderRunPostureResolution,
  renderRunPostureSummary,
  summarizeRunPosture,
} from './run-detail-posture-renderers.js';

function capability(
  overrides: Partial<ResourcePostureCapabilityState> = {},
): ResourcePostureCapabilityState {
  return {
    capabilityId: 'browser-cdp',
    desiredDisposition: 'acquired',
    observedState: 'running',
    policySource: 'framework-default',
    reason: 'required by the current proof plan',
    releaseEffects: ['Closes the CDP browser'],
    ...overrides,
  };
}

function postureState(overrides: Partial<RunResourcePostureState> = {}): RunResourcePostureState {
  return {
    posture: 'operator-wait',
    policySource: 'gate-choice',
    capabilities: [capability()],
    workerRetained: true,
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

test('the summary reports the Gateway policy source rather than deriving one', () => {
  const summary = summarizeRunPosture(postureState({ gateChoice: 'minimize' }));

  assert.equal(summary.posture, 'operator-wait');
  assert.equal(summary.postureLabel, 'Operator wait');
  assert.equal(summary.policySource, 'gate-choice');
  assert.equal(summary.policySourceLabel, 'operator gate choice');
  assert.equal(summary.gateChoice, 'minimize');
  assert.equal(policySourceLabel('run-dispatch'), 'run dispatch config');
  assert.equal(policySourceLabel('project-default'), 'project default');
});

test('counts describe what the providers are observed doing', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({ capabilityId: 'a', desiredDisposition: 'acquired', observedState: 'running' }),
        capability({ capabilityId: 'b', desiredDisposition: 'warm', observedState: 'running' }),
        capability({ capabilityId: 'c', desiredDisposition: 'stopped', observedState: 'stopped' }),
      ],
    }),
  );

  assert.deepEqual(summary.counts, {
    retained: 1,
    warm: 1,
    stopped: 1,
    failed: 0,
    unresolved: 0,
  });
});

test('a provider still running against a stop intent is never counted as stopped', () => {
  // The regression this guards: counting by desired disposition would report
  // "1 stopped" for a provider that is demonstrably still up.
  const summary = summarizeRunPosture(
    postureState({
      posture: 'terminal',
      capabilities: [
        capability({
          capabilityId: 'metro',
          desiredDisposition: 'stopped',
          observedState: 'running',
        }),
      ],
    }),
  );

  assert.equal(summary.counts.stopped, 0);
  assert.equal(summary.counts.unresolved, 1);
  assert.equal(summary.rows[0]?.rowStatus, 'mismatch');
});

test('a failed cleanup is counted once, as failed, and never also as stopped', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          capabilityId: 'metro',
          desiredDisposition: 'stopped',
          observedState: 'stopped',
          cleanupFailure: 'shutdown action exited 1',
        }),
      ],
    }),
  );

  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.stopped, 0);
});

test('a capability the last transition failed on counts as failed even with a clean row', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          capabilityId: 'metro',
          desiredDisposition: 'stopped',
          observedState: 'stopped',
        }),
      ],
      lastTransition: {
        id: 'op-1',
        posture: 'terminal',
        policySource: 'framework-default',
        requestedAt: '2026-09-05T10:00:00.000Z',
        outcome: 'partial',
        effects: [],
        progress: { total: 1, completed: 0 },
        failures: [{ capabilityId: 'metro', reason: 'shutdown timed out' }],
      },
    }),
  );

  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.stopped, 0);
});

test('every row lands in exactly one bucket, so the counts never hide one', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({ capabilityId: 'a', desiredDisposition: 'acquired', observedState: 'running' }),
        capability({ capabilityId: 'b', desiredDisposition: 'stopped', observedState: 'unknown' }),
        capability({
          capabilityId: 'c',
          desiredDisposition: 'stopped',
          observedState: 'transitioning',
        }),
        capability({
          capabilityId: 'd',
          desiredDisposition: 'acquired',
          observedState: 'unhealthy',
        }),
      ],
    }),
  );

  const { retained, warm, stopped, failed, unresolved } = summary.counts;
  assert.equal(retained + warm + stopped + failed + unresolved, summary.rows.length);
});

test('an unknown observation is never claimed as matching or mismatching intent', () => {
  assert.equal(resourcePostureRowStatus('acquired', 'unknown'), 'unproven');
  assert.equal(resourcePostureRowStatus('stopped', 'unknown'), 'unproven');
  assert.equal(resourcePostureRowStatus('stopped', 'transitioning'), 'pending');

  const summary = summarizeRunPosture(
    postureState({
      capabilities: [capability({ desiredDisposition: 'stopped', observedState: 'unknown' })],
    }),
  );
  assert.equal(summary.counts.failed, 0);
  assert.equal(summary.counts.unresolved, 1);
  assert.equal(summary.rows[0]?.rowStatus, 'unproven');
});

test('a released lease kept alive by keep-warm reads as warm and running, not stopped', () => {
  const row = postureCapabilityRow(
    capability({
      desiredDisposition: 'warm',
      observedState: 'running',
      warmUntil: '2026-09-05T10:30:00.000Z',
      reason: 'project retention warm at operator-wait',
    }),
  );

  assert.equal(row.desiredLabel, 'warm');
  assert.equal(row.rowStatus, 'matches');
  assert.equal(row.warmUntil, '2026-09-05T10:30:00.000Z');
});

test('the last transition and its failures survive into the summary', () => {
  const summary = summarizeRunPosture(
    postureState({
      lastTransition: {
        id: 'op-1',
        posture: 'terminal',
        policySource: 'framework-default',
        requestedAt: '2026-09-05T10:00:00.000Z',
        completedAt: '2026-09-05T10:00:05.000Z',
        outcome: 'partial',
        effects: ['Stops Metro'],
        progress: { total: 2, completed: 1 },
        failures: [{ capabilityId: 'metro', reason: 'shutdown timed out' }],
      },
    }),
  );

  assert.equal(summary.lastTransition?.outcome, 'partial');
  assert.deepEqual(summary.lastTransition?.failures, [
    { capabilityId: 'metro', reason: 'shutdown timed out' },
  ]);
});

test('a park rejection is shown with the machine-parking code it came from', () => {
  assert.match(
    rejectionMessage({
      kind: 'park-ineligible',
      code: 'gate-held-worker',
      reason: 'the run holds a gate-held worker session',
    }),
    /gate-held-worker.*gate-held worker session/,
  );
  assert.match(
    rejectionMessage({
      kind: 'capability-unavailable',
      capabilityId: 'ios-simulator',
      reason: 'device is offline',
      conflict: { kind: 'host-pressure', reason: 'memory', severity: 'warn', queued: false },
    }),
    /ios-simulator is unavailable: device is offline/,
  );
});

test('a run holding nothing still reports its posture and worker retention', () => {
  const summary = summarizeRunPosture(
    postureState({ posture: 'active', policySource: 'framework-default', capabilities: [] }),
  );

  assert.equal(summary.rows.length, 0);
  assert.deepEqual(summary.counts, {
    retained: 0,
    warm: 0,
    stopped: 0,
    failed: 0,
    unresolved: 0,
  });
  assert.equal(summary.workerRetained, true);
});

test('a cleanup failure shown on its row is not repeated in the transition list', () => {
  // The same failure reaches both places. Rendering both gave the operator the
  // identical alert twice.
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          capabilityId: 'metro',
          desiredDisposition: 'stopped',
          observedState: 'stopped',
          cleanupFailure: 'shutdown action exited 1',
        }),
      ],
      lastTransition: {
        id: 'op-1',
        posture: 'terminal',
        policySource: 'framework-default',
        requestedAt: '2026-09-05T10:00:00.000Z',
        outcome: 'partial',
        effects: [],
        progress: { total: 1, completed: 0 },
        failures: [{ capabilityId: 'metro', reason: 'shutdown action exited 1' }],
      },
    }),
  );

  assert.equal(summary.rows[0]?.cleanupFailure, 'shutdown action exited 1');
  assert.deepEqual(postureTransitionFailuresToShow(summary), []);
});

test('a transition failure with no row of its own is still shown', () => {
  // Losing it would hide the only report of that capability's failure.
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [capability({ capabilityId: 'browser-cdp' })],
      lastTransition: {
        id: 'op-2',
        posture: 'terminal',
        policySource: 'framework-default',
        requestedAt: '2026-09-05T10:00:00.000Z',
        outcome: 'partial',
        effects: [],
        progress: { total: 1, completed: 0 },
        failures: [{ capabilityId: 'ios-simulator', reason: 'device never shut down' }],
      },
    }),
  );

  assert.deepEqual(postureTransitionFailuresToShow(summary), [
    { capabilityId: 'ios-simulator', reason: 'device never shut down' },
  ]);
});

test('a sibling lease failure with a different reason is still shown', () => {
  // The Gateway reports one failure per lease; a row carries a single reason.
  // Suppressing every failure for that capability would drop the sibling's
  // failure entirely, and the transition list is its only report.
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          capabilityId: 'ios-simulator',
          desiredDisposition: 'stopped',
          observedState: 'stopped',
          cleanupFailure: 'first lease: shutdown exited 1',
        }),
      ],
      lastTransition: {
        id: 'op-3',
        posture: 'terminal',
        policySource: 'framework-default',
        requestedAt: '2026-09-05T10:00:00.000Z',
        outcome: 'partial',
        effects: [],
        progress: { total: 2, completed: 0 },
        failures: [
          { capabilityId: 'ios-simulator', reason: 'first lease: shutdown exited 1' },
          { capabilityId: 'ios-simulator', reason: 'second lease: device never released' },
        ],
      },
    }),
  );

  // The one already on the row is suppressed; the sibling's own reason survives.
  assert.deepEqual(postureTransitionFailuresToShow(summary), [
    { capabilityId: 'ios-simulator', reason: 'second lease: device never released' },
  ]);
});

test('the persistent summary carries the resolution outcome after the gate disappears', () => {
  const transition: ResourcePostureTransition = {
    id: 'op-1',
    posture: 'operator-wait',
    policySource: 'gate-choice',
    requestedAt: '2026-09-05T12:00:00.000Z',
    completedAt: '2026-09-05T12:00:02.000Z',
    outcome: 'partial',
    effects: [],
    progress: { total: 2, completed: 1 },
    failures: [{ capabilityId: 'metro', reason: 'stop timed out' }],
  };
  // The gate panel is gone once the decision resolves, so this is the only place
  // the operator can still read what their resolution did.
  const applied = renderRunPostureResolution({ appliedTransition: transition });
  assert.notEqual(applied, nothing);

  // Pending wins over any stale record: an unfinished reconciliation is not an
  // outcome, and showing the previous one would answer the wrong question.
  const pending = renderRunPostureResolution({
    appliedTransition: transition,
    reconciliationPending: true,
  });
  assert.notEqual(pending, nothing);
  assert.notDeepEqual(pending, applied);

  // Nothing resolved, nothing claimed.
  assert.equal(renderRunPostureResolution({}), nothing);
});

test('a withheld choice is reported in every summary branch, including a failed read', () => {
  const withheld = {
    withheldChoiceReason: 'Resource posture is unknown, so the Free the slot choice is withheld.',
  };
  // A failed status read is exactly when a choice is withheld, so the branch
  // that reports the failure must also report the withholding.
  assert.notEqual(renderRunPostureSummary({ status: 'error', message: 'boom' }, withheld), nothing);
  assert.notEqual(renderRunPostureSummary({ status: 'loading' }, withheld), nothing);
  // And it is visible on its own, without any resolution to accompany it.
  assert.notEqual(renderRunPostureResolution(withheld), nothing);
  assert.equal(renderRunPostureResolution({ withheldChoiceReason: null }), nothing);
});

test('a positional match is not described as the operator own resolution', () => {
  const transition: ResourcePostureTransition = {
    id: 'op-1',
    posture: 'operator-wait',
    policySource: 'framework-default',
    requestedAt: '2026-09-05T12:00:00.000Z',
    outcome: 'applied',
    effects: [],
    progress: { total: 1, completed: 1 },
    failures: [],
  };
  // The shared contract admits a positional match may belong to a concurrent
  // reconciliation, so only an attributed one may be called the operator's.
  const attributed = renderRunPostureResolution({
    appliedTransition: transition,
    appliedTransitionAttributed: true,
  });
  const positional = renderRunPostureResolution({
    appliedTransition: transition,
    appliedTransitionAttributed: false,
  });
  assert.notDeepEqual(attributed, positional);
  assert.notEqual(positional, nothing);
});
