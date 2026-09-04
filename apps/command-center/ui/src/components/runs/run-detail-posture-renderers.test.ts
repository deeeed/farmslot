import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourcePostureCapabilityState, RunResourcePostureState } from '@farmslot/protocol';

import {
  policySourceLabel,
  postureCapabilityRow,
  postureRowStatus,
  rejectionMessage,
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

test('counts group by desired disposition, not by what the provider is doing', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({ capabilityId: 'a', desiredDisposition: 'acquired', observedState: 'running' }),
        capability({ capabilityId: 'b', desiredDisposition: 'warm', observedState: 'running' }),
        capability({ capabilityId: 'c', desiredDisposition: 'stopped', observedState: 'stopped' }),
      ],
    }),
  );

  assert.deepEqual(summary.counts, { retained: 1, warm: 1, stopped: 1, failed: 0 });
});

test('a provider still running against a stop intent counts as failed, never as stopped', () => {
  // The regression this guards: counting by desired disposition alone would
  // report "1 stopped" for a provider that is demonstrably still up.
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

  assert.equal(summary.counts.stopped, 1);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.rows[0]?.rowStatus, 'mismatch');
});

test('a cleanup failure is counted even when the observed state agrees with intent', () => {
  const summary = summarizeRunPosture(
    postureState({
      capabilities: [
        capability({
          desiredDisposition: 'stopped',
          observedState: 'stopped',
          cleanupFailure: 'shutdown action exited 1',
        }),
      ],
    }),
  );

  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.rows[0]?.cleanupFailure, 'shutdown action exited 1');
});

test('an unknown observation is never claimed as matching or mismatching intent', () => {
  assert.equal(postureRowStatus('acquired', 'unknown'), 'unproven');
  assert.equal(postureRowStatus('stopped', 'unknown'), 'unproven');
  assert.equal(postureRowStatus('stopped', 'transitioning'), 'pending');

  const summary = summarizeRunPosture(
    postureState({
      capabilities: [capability({ desiredDisposition: 'stopped', observedState: 'unknown' })],
    }),
  );
  assert.equal(summary.counts.failed, 0);
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
  assert.deepEqual(summary.counts, { retained: 0, warm: 0, stopped: 0, failed: 0 });
  assert.equal(summary.workerRetained, true);
});
