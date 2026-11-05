import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import {
  type EventFrame,
  Events,
  isRecord,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityLifecyclePayload,
  type RuntimeCapabilityListResult,
  RuntimeCapabilityMethods,
  type RuntimeCapabilityReleaseResult,
} from '@farmslot/protocol';

import type { GatewayConnection } from '../gateway-client.js';

import {
  type RecordingResourceRequest,
  withRecordingResource,
} from './recipe-recording-resource.js';

function fixture(queued = false, borrowedInitially = false) {
  let ready = !queued;
  let listener = (_event: EventFrame): void => {};
  let closeListener = (): void => {};
  let closed = false;
  let borrowed = borrowedInitially;
  const controls = { releaseBeforeReply: false, oldGateway: false, failRelease: false };
  const calls: Array<{ method: string; params: unknown }> = [];
  const lease: RuntimeCapabilityLease = {
    id: 'proof-lease',
    slotId: 'slot',
    project: 'example',
    capabilityId: 'testnet',
    purpose: 'recording',
    owner: { runId: 'run' },
    state: 'acquired',
    referenceCount: 1,
    parameters: {},
    provenance: { project: 'example', providerId: 'testnet', version: '1', digest: 'digest' },
    health: { state: 'healthy', checkedAt: '2026-11-05T00:00:00Z' },
    dependencyLeaseIds: [],
    updatedAt: '2026-11-05T00:00:00Z',
  };
  const connection: GatewayConnection = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === RuntimeCapabilityMethods.list) {
        const result: RuntimeCapabilityListResult = {
          slotId: 'slot',
          project: 'example',
          ...(controls.oldGateway ? {} : { recordingCapability: 'testnet' }),
          capabilities: [],
        };
        return result as T;
      }
      if (method === RuntimeCapabilityMethods.acquire) {
        assert.ok(isRecord(params) && typeof params.invocationId === 'string');
        lease.invocationId = params.invocationId;
        if (controls.releaseBeforeReply)
          listener({
            type: 'event',
            event: Events.RUNTIME_CAPABILITY_LIFECYCLE,
            payload: {
              event: {
                at: '2026-11-05T00:00:00Z',
                slotId: 'slot',
                capabilityId: 'testnet',
                owner: { runId: 'run' },
                leaseId: lease.id,
                kind: 'released',
              },
            } satisfies RuntimeCapabilityLifecyclePayload,
          });
        const result: RuntimeCapabilityAcquireResult = ready
          ? { ok: true, lease, dependencyLeases: [], idempotent: borrowed }
          : {
              ok: false,
              conflict: {
                kind: 'scoped-wait',
                capabilityId: 'testnet',
                claimId: 'shared-testnet',
                scope: 'fleet',
                owner: { runId: 'holder' },
                leaseId: 'holder-lease',
                queuedLeaseId: lease.id,
                position: 1,
                reason: 'Capacity is full',
              },
            };
        return result as T;
      }
      assert.equal(method, RuntimeCapabilityMethods.release);
      if (controls.failRelease) throw new Error('release failed');
      const result: RuntimeCapabilityReleaseResult = {
        ok: true,
        released: [lease],
        retained: [],
        effects: [],
        failures: [],
      };
      return result as T;
    },
    onEvent(handler) {
      listener = handler;
      return () => {
        listener = () => {};
      };
    },
    onClose(handler) {
      closeListener = handler;
      return () => {
        closeListener = () => {};
      };
    },
    close() {
      closed = true;
    },
  };
  const request: RecordingResourceRequest = {
    capabilityId: 'testnet',
    slotId: 'slot',
    runId: 'run',
    recorded: true,
    options: {},
  };
  return {
    request,
    calls,
    connection,
    controls,
    connect: async () => connection,
    grant() {
      ready = true;
      borrowed = queued;
      listener({
        type: 'event',
        event: Events.RUNTIME_CAPABILITY_LIFECYCLE,
        payload: {
          event: {
            at: '2026-11-05T00:00:00Z',
            slotId: 'slot',
            capabilityId: 'testnet',
            owner: { runId: 'run' },
            leaseId: lease.id,
            kind: 'acquired',
          },
        } satisfies RuntimeCapabilityLifecyclePayload,
      });
    },
    unrelated() {
      listener({
        type: 'event',
        event: Events.RUNTIME_CAPABILITY_LIFECYCLE,
        payload: {
          event: {
            at: '2026-11-05T00:00:00Z',
            slotId: 'other-slot',
            owner: { runId: 'other' },
            capabilityId: 'testnet',
            kind: 'acquired',
          },
        } satisfies RuntimeCapabilityLifecyclePayload,
      });
    },
    disconnect() {
      closeListener();
    },
    closed: () => closed,
    invocation: () => lease.invocationId,
  };
}

test('a recorded proof waits for its queued resource before running fixture setup', async () => {
  const f = fixture(true);
  let invoked = false;
  const proof = withRecordingResource(
    f.request,
    async () => {
      invoked = true;
      return 'proof';
    },
    f.connect,
  );
  await setImmediate();
  assert.equal(invoked, false);
  assert.equal(f.calls.length, 2);
  f.unrelated();
  await setImmediate();
  assert.equal(f.calls.length, 2, 'unrelated events do not rescan or poll');
  f.grant();
  assert.equal(await proof, 'proof');
  assert.equal(invoked, true);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    [
      RuntimeCapabilityMethods.list,
      RuntimeCapabilityMethods.acquire,
      RuntimeCapabilityMethods.acquire,
      RuntimeCapabilityMethods.release,
    ],
  );
  assert.equal(f.closed(), true);
});

test('failed proof execution releases its permit and retains the failure', async () => {
  const f = fixture();
  await assert.rejects(
    withRecordingResource(
      f.request,
      async () => {
        throw new Error('proof failed');
      },
      f.connect,
    ),
    /proof failed/,
  );
  assert.equal(f.calls.at(-1)?.method, RuntimeCapabilityMethods.release);
  assert.equal(f.closed(), true);
});

test('cancelling a queued proof releases its exact queue place without executing', async () => {
  const f = fixture(true);
  const controller = new AbortController();
  const proof = withRecordingResource(
    { ...f.request, signal: controller.signal },
    async () => assert.fail('proof started while queued'),
    f.connect,
  );
  await setImmediate();
  controller.abort(new Error('cancelled proof'));
  await assert.rejects(proof, /cancelled proof/);
  assert.deepEqual(f.calls.at(-1)?.params, {
    slotId: 'slot',
    ownerRunId: 'run',
    capabilityId: 'testnet',
    invocationId: f.invocation(),
    keepWarm: false,
  });
});

test('unrecorded commands and unconfigured projects do not contact the gateway', async () => {
  const f = fixture();
  const connect = async (): Promise<GatewayConnection> => assert.fail('unexpected connection');
  assert.equal(
    await withRecordingResource({ ...f.request, recorded: false }, async () => 1, connect),
    1,
  );
  assert.equal(
    await withRecordingResource({ ...f.request, capabilityId: undefined }, async () => 2, connect),
    2,
  );
});

test('configured recorded proofs require an explicit run and slot before acquiring', async () => {
  const f = fixture();
  for (const request of [
    { ...f.request, runId: undefined },
    { ...f.request, slotId: undefined },
  ])
    await assert.rejects(
      withRecordingResource(
        request,
        async () => assert.fail('proof bypassed admission'),
        f.connect,
      ),
      /run.*slot|slot.*run/,
    );
  assert.equal(f.calls.length, 0);
});

test('an idempotent reply for this invocation remains owned and is released', async () => {
  const f = fixture(false, true);
  assert.equal(await withRecordingResource(f.request, async () => 'proof', f.connect), 'proof');
  assert.deepEqual(
    f.calls.map((call) => call.method),
    [
      RuntimeCapabilityMethods.list,
      RuntimeCapabilityMethods.acquire,
      RuntimeCapabilityMethods.release,
    ],
  );
});

test('a gateway disconnect aborts a queued proof instead of starting it', async () => {
  const f = fixture(true);
  const proof = withRecordingResource(
    f.request,
    async () => assert.fail('disconnected proof started'),
    f.connect,
  );
  await setImmediate();
  f.disconnect();
  await assert.rejects(proof, /Gateway connection closed/);
  assert.equal(f.calls.at(-1)?.method, RuntimeCapabilityMethods.release);
});

test('managed proofs bind the existing task owner receipt without an extra flag', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'recording-owner-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'inputs'));
  await writeFile(
    path.join(taskDir, 'inputs/runtime-capability-catalog.json'),
    JSON.stringify({
      version: 1,
      ownerRunId: 'run',
      slotId: 'slot',
      project: 'example',
      providers: null,
    }),
  );
  const f = fixture();
  const request = { ...f.request, runId: undefined, project: 'example', taskDir };
  assert.equal(await withRecordingResource(request, async () => 'proof', f.connect), 'proof');
  assert.deepEqual(f.calls[1]?.params, {
    slotId: 'slot',
    capabilityId: 'testnet',
    ownerRunId: 'run',
    invocationId: f.invocation(),
    proofRequirement: {
      capabilityId: 'testnet',
      reason: 'Recorded recipe proof, including fixture setup',
      mode: 'visual',
    },
    queueOnConflict: true,
  });
  for (const mismatch of [{ runId: 'other' }, { slotId: 'other' }, { project: 'other' }])
    await assert.rejects(
      withRecordingResource(
        { ...request, ...mismatch },
        async () => assert.fail('foreign task ran'),
        f.connect,
      ),
      /does not match/,
    );
});

test('a gateway without invocation admission is refused before any lease mutation', async () => {
  const f = fixture();
  f.controls.oldGateway = true;
  await assert.rejects(
    withRecordingResource(
      f.request,
      async () => assert.fail('old gateway admitted proof'),
      f.connect,
    ),
    /gateway must support/,
  );
  assert.deepEqual(
    f.calls.map((call) => call.method),
    [RuntimeCapabilityMethods.list],
  );
});

test('release before the acquire reply prevents fixture execution', async () => {
  const f = fixture();
  f.controls.releaseBeforeReply = true;
  await assert.rejects(
    withRecordingResource(
      f.request,
      async () => assert.fail('released permit admitted proof'),
      f.connect,
    ),
    /released before execution/,
  );
});

test('cleanup failure retains both execution and release failures', async () => {
  const f = fixture();
  f.controls.failRelease = true;
  const executionFailure = new Error('proof failed');
  await assert.rejects(
    withRecordingResource(
      f.request,
      async () => {
        throw executionFailure;
      },
      f.connect,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], executionFailure);
      assert.equal(error.errors[1].message, 'release failed');
      return true;
    },
  );
  assert.equal(f.closed(), true);
});
