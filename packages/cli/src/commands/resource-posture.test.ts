import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ResourcePostureCapabilityState,
  ResourcePosturePlan,
  RunResourcePostureState,
  RuntimeCapabilityAcquireParams,
  RuntimeCapabilityLease,
  RuntimeCapabilityReleaseParams,
  RuntimeCapabilityReleaseResult,
  RuntimeCapabilityStopWarmResult,
  RuntimePostureApplyResult,
  RuntimePostureStatusResult,
} from '@farmslot/protocol';

import {
  capabilityLines,
  formatCapabilityAcquire,
  formatCapabilityRelease,
  formatPostureApply,
  formatPosturePlan,
  formatPostureStatus,
  formatStopWarm,
  postureApplyFailed,
  rejectionLine,
} from './resource-posture.js';

function capability(
  overrides: Partial<ResourcePostureCapabilityState> = {},
): ResourcePostureCapabilityState {
  return {
    capabilityId: 'browser-cdp',
    desiredDisposition: 'acquired',
    observedState: 'running',
    policySource: 'framework-default',
    reason: 'required by the current proof plan',
    releaseEffects: ['stop chrome'],
    ...overrides,
  };
}

function postureState(overrides: Partial<RunResourcePostureState> = {}): RunResourcePostureState {
  return {
    posture: 'operator-wait',
    policySource: 'run-dispatch',
    workerRetained: true,
    capabilities: [capability()],
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function statusResult(state: RunResourcePostureState): RuntimePostureStatusResult {
  return { runId: 'run-1', slotId: 'macpro-ff-1', state };
}

function lease(overrides: Partial<RuntimeCapabilityLease> = {}): RuntimeCapabilityLease {
  return {
    id: 'lease-1',
    slotId: 'macpro-ff-1',
    project: 'farmslot-farm',
    capabilityId: 'browser-cdp',
    owner: { runId: 'run-1' },
    state: 'acquired',
    referenceCount: 1,
    parameters: {},
    provenance: {
      project: 'farmslot-farm',
      providerId: 'browser-cdp',
      version: '1',
      digest: 'abc',
    },
    health: { state: 'healthy' },
    dependencyLeaseIds: [],
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

test('status shows desired disposition beside observed state, warm deadline, and policy source', () => {
  const output = formatPostureStatus(
    statusResult(
      postureState({
        gateChoice: 'minimize',
        waitPolicy: 'minimize',
        capabilities: [
          capability({
            capabilityId: 'companion-metro',
            desiredDisposition: 'warm',
            observedState: 'running',
            policySource: 'project-default',
            reason: 'project retention warm at operator-wait',
            warmUntil: '2026-09-05T00:10:00.000Z',
          }),
        ],
      }),
    ),
  );
  assert.match(output, /run=run-1/);
  assert.match(output, /slot=macpro-ff-1/);
  assert.match(output, /posture=operator-wait/);
  assert.match(output, /policy=run-dispatch/);
  assert.match(output, /choice=minimize/);
  assert.match(output, /dispatch-preset=minimize/);
  assert.match(output, /worker=retained/);
  assert.match(output, /companion-metro {2}wants=warm {2}observed=running/);
  assert.match(output, /warm-until=2026-09-05T00:10:00\.000Z/);
  assert.match(output, /\[policy: project-default\]/);
  assert.match(output, /1 warm/);
});

test('status never counts a provider as stopped when the Gateway did not observe it stopped', () => {
  const output = formatPostureStatus(
    statusResult(
      postureState({
        posture: 'terminal',
        capabilities: [
          // Told to stop, cleanup failed: this is a failure, not a stop.
          capability({
            capabilityId: 'ios-simulator',
            desiredDisposition: 'stopped',
            observedState: 'unhealthy',
            cleanupFailure: 'shutdown action exited 1',
          }),
          // Told to stop, still running: unresolved, not stopped either.
          capability({
            capabilityId: 'companion-metro',
            desiredDisposition: 'stopped',
            observedState: 'running',
          }),
        ],
      }),
    ),
  );
  assert.match(output, /0 stopped/);
  assert.match(output, /1 failed/);
  assert.match(output, /1 unresolved/);
  assert.match(output, /cleanup failed: shutdown action exited 1/);
  assert.match(output, /ios-simulator {2}wants=stopped {2}observed=unhealthy/);
  assert.match(output, /companion-metro {2}wants=stopped {2}observed=running/);
  assert.doesNotMatch(output, /observed=stopped/);
});

test('status reports a transition failure that no capability entry already carries', () => {
  const state = postureState({
    capabilities: [capability({ capabilityId: 'metro', cleanupFailure: 'stop timed out' })],
    lastTransition: {
      id: 'op-1',
      posture: 'terminal',
      policySource: 'framework-default',
      requestedAt: '2026-09-05T00:00:00.000Z',
      completedAt: '2026-09-05T00:00:05.000Z',
      outcome: 'partial',
      effects: ['stop metro bundler'],
      progress: { total: 2, completed: 1 },
      failures: [
        // Same capability, same reason as the entry above: already reported.
        { capabilityId: 'metro', reason: 'stop timed out' },
        // A sibling lease of the same capability failed differently.
        { capabilityId: 'metro', leaseId: 'lease-9', reason: 'port still bound' },
      ],
    },
  });
  const output = formatPostureStatus(statusResult(state));
  assert.match(output, /outcome=partial/);
  assert.match(output, /steps=1\/2/);
  assert.match(output, /transition failure on metro: port still bound/);
  assert.equal(output.match(/stop timed out/g)?.length, 1);
});

test('preview lists acquire, retain, warm, and stop groups with their declared effects', () => {
  const plan: ResourcePosturePlan = {
    runId: 'run-1',
    slotId: 'macpro-ff-1',
    posture: 'operator-wait',
    policySource: 'project-default',
    reason: 'project default sheds expensive providers at an operator wait',
    acquire: [],
    retain: [capability({ capabilityId: 'sandbox-gateway-ui' })],
    warm: [capability({ capabilityId: 'browser-cdp', desiredDisposition: 'warm' })],
    stop: [
      capability({
        capabilityId: 'ios-simulator',
        desiredDisposition: 'stopped',
        observedState: 'running',
      }),
    ],
    effects: ['The simulator is shut down'],
  };
  const output = formatPosturePlan(plan);
  assert.match(output, /posture=operator-wait {2}policy=project-default/);
  assert.match(output, /acquire none/);
  assert.match(output, /retain {2}sandbox-gateway-ui/);
  assert.match(output, /warm {4}browser-cdp/);
  assert.match(output, /stop {4}ios-simulator/);
  assert.match(output, /effects: The simulator is shut down/);
});

test('a previewed rejection is rendered, and park ineligibility keeps the Gateway code', () => {
  assert.match(
    rejectionLine({
      kind: 'park-ineligible',
      code: 'STATUS_NOT_ELIGIBLE',
      reason: "status 'human-gating' is not monitoring or ci-watching",
    }),
    /cannot be parked \(STATUS_NOT_ELIGIBLE\)/,
  );
  assert.match(
    rejectionLine({
      kind: 'capability-unavailable',
      capabilityId: 'browser-cdp',
      reason: 'held by run-2',
      conflict: {
        kind: 'lease-conflict',
        capabilityId: 'browser-cdp',
        owner: { runId: 'run-2' },
        leaseId: 'lease-2',
        reason: 'held by run-2',
      },
    }),
    /browser-cdp is unavailable \(lease-conflict\)/,
  );
});

test('apply reports the transition outcome, and only an incomplete outcome is a failure', () => {
  const applied: RuntimePostureApplyResult = {
    ok: true,
    status: postureState({ posture: 'terminal' }),
    transition: {
      id: 'op-2',
      posture: 'terminal',
      policySource: 'framework-default',
      requestedAt: '2026-09-05T00:00:00.000Z',
      completedAt: '2026-09-05T00:00:02.000Z',
      outcome: 'applied',
      effects: ['stop chrome'],
      progress: { total: 1, completed: 1 },
      failures: [],
    },
  };
  const output = formatPostureApply('run-1', applied);
  assert.match(output, /Posture apply {2}run=run-1 {2}ok=yes/);
  assert.match(output, /outcome=applied/);
  assert.match(output, /effects: stop chrome/);
  // The status block has no slot on an apply result, so it must not invent one.
  assert.doesNotMatch(output, /slot=/);
  assert.equal(postureApplyFailed(applied), false);

  const idempotent = { ...applied, transition: { ...applied.transition, outcome: 'idempotent' } };
  assert.equal(postureApplyFailed(idempotent as RuntimePostureApplyResult), false);
  for (const outcome of ['rejected', 'failed', 'partial'] as const) {
    assert.equal(
      postureApplyFailed({
        ...applied,
        transition: { ...applied.transition, outcome },
      }),
      true,
      `${outcome} must be reported as an incomplete transition`,
    );
  }
  assert.equal(postureApplyFailed({ ...applied, ok: false }), true);
});

test('stop-warm prints the Gateway outcome and observed state without claiming a stop', () => {
  const deferred: RuntimeCapabilityStopWarmResult = {
    ok: true,
    slotId: 'macpro-ff-1',
    capabilityId: 'companion-metro',
    outcome: 'deferred',
    observedState: 'running',
    reason: 'ios-simulator still needs it',
    effects: [],
  };
  const output = formatStopWarm(deferred);
  assert.match(output, /outcome=deferred {2}observed=running/);
  assert.match(output, /ios-simulator still needs it/);
  assert.match(output, /effects: none/);

  const failed: RuntimeCapabilityStopWarmResult = {
    ok: false,
    slotId: 'macpro-ff-1',
    capabilityId: 'browser-cdp',
    outcome: 'failed',
    observedState: 'unknown',
    cleanupFailure: 'stop action exited 1',
    effects: [],
  };
  const failedOutput = formatStopWarm(failed);
  assert.match(failedOutput, /outcome=failed {2}observed=unknown/);
  assert.match(failedOutput, /cleanup failed: stop action exited 1/);
});

test('acquire renders the lease and dependencies, and a refusal keeps the conflict kind', () => {
  const params: RuntimeCapabilityAcquireParams = {
    slotId: 'macpro-ff-1',
    capabilityId: 'ios-simulator',
    ownerRunId: 'run-1',
    proofRequirement: {
      capabilityId: 'ios-simulator',
      reason: 'recover the simulator',
      mode: 'state',
    },
  };
  const granted = formatCapabilityAcquire(
    {
      ok: true,
      lease: lease({ capabilityId: 'ios-simulator' }),
      dependencyLeases: [lease({ id: 'lease-2', capabilityId: 'companion-metro' })],
      idempotent: false,
    },
    params,
  );
  assert.match(granted, /acquired/);
  assert.match(granted, /ios-simulator {2}lease=lease-1 {2}state=acquired {2}health=healthy/);
  assert.match(granted, /dependencies:/);
  assert.match(granted, /companion-metro {2}lease=lease-2/);

  const refused = formatCapabilityAcquire(
    {
      ok: false,
      conflict: {
        kind: 'host-pressure',
        reason: 'machine is critical',
        severity: 'critical',
        queued: false,
      },
    },
    params,
  );
  assert.match(refused, /refused \(host-pressure\): machine is critical/);
});

test('release says whether the provider was left warm and never hides a cleanup failure', () => {
  const params: RuntimeCapabilityReleaseParams = {
    slotId: 'macpro-ff-1',
    ownerRunId: 'run-1',
    capabilityId: 'browser-cdp',
  };
  const result: RuntimeCapabilityReleaseResult = {
    ok: false,
    released: [lease({ state: 'released', keepWarmUntil: '2026-09-05T00:10:00.000Z' })],
    retained: [lease({ id: 'lease-3', capabilityId: 'companion-metro' })],
    effects: ['chrome remains reusable until the keep-warm deadline'],
    failures: [{ leaseId: 'lease-4', capabilityId: 'recording', reason: 'helper did not exit' }],
  };
  const warm = formatCapabilityRelease(result, params);
  assert.match(warm, /keep-warm=yes \(provider may stay live\)/);
  assert.match(warm, /warm-until=2026-09-05T00:10:00\.000Z/);
  assert.match(warm, /retained for another holder:/);
  assert.match(warm, /cleanup failed on recording \(lease-4\): helper did not exit/);

  const stopped = formatCapabilityRelease(result, { ...params, keepWarm: false });
  assert.match(stopped, /keep-warm=no \(provider stopped\)/);
});

test('a capability entry is rendered as pending or unobserved rather than as a match', () => {
  assert.match(
    capabilityLines(capability({ observedState: 'transitioning' })).join('\n'),
    /pending/,
  );
  assert.match(capabilityLines(capability({ observedState: 'unknown' })).join('\n'), /unobserved/);
  assert.match(
    capabilityLines(capability({ desiredDisposition: 'stopped', observedState: 'running' })).join(
      '\n',
    ),
    /mismatch/,
  );
});
