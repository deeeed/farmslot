// The gap this file closes: the gateway's wait is gated on an error code, and both
// native routes used to flatten every failure into NATIVE_SESSION_ERROR. Tests that
// mocked the route and threw the raw code stayed green while the real path refused at
// once. These enter through routeNativeSession / routeNativeWorkerSession.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods } from '@farmslot/protocol/rpc';

import { NativeSessionClient } from './client.js';
import {
  isNativeHostNotReadyError,
  isNativeHostUnavailableError,
  NATIVE_HOST_UNAVAILABLE,
  nativeHostUnavailableError,
} from './host-unavailable.js';
import { NativeSessionMethodError, routeNativeSession } from './service.js';
import { NATIVE_WORKER_ENSURE } from './worker-launch.js';
import { routeNativeWorkerSession } from './worker-service.js';

const LEASE = '66666666-7777-8888-9999-aaaaaaaaaaaa';

const sourceUnavailable = () =>
  Object.assign(new Error('Native host unavailable; refresh it from the login context'), {
    code: 'NATIVE_SOURCE_UNAVAILABLE',
  });

/** Only what each route reaches before it fails; everything else is unused here. */
function clientThatCannotReachItsHost(failure: Error) {
  return new (class extends NativeSessionClient {
    override async list(): Promise<never> {
      throw failure;
    }
    override async ensureWorker(): Promise<never> {
      throw failure;
    }
  })('/unused-native-host-fixture');
}

const worker = (failure: Error) =>
  routeNativeWorkerSession(clientThatCannotReachItsHost(failure), 'owner', NATIVE_WORKER_ENSURE, {
    sessionId: '11111111-2222-3333-4444-555555555555',
    leaseId: LEASE,
    runner: 'claude',
    cwd: '/repo',
    launch: { leaseId: LEASE, safetyTier: 'sandboxed', environment: { set: {}, unset: [] } },
  });

const session = (failure: Error) =>
  routeNativeSession(clientThatCannotReachItsHost(failure), 'owner', Methods.NATIVE_SESSION_LIST, {
    executionNodeId: 'local',
  });

for (const [label, failure] of [
  ['a live start that never became ready', nativeHostUnavailableError('/root/host.log')],
  ['a passive read that found no host', sourceUnavailable()],
] as const) {
  test(`the worker route keeps the code of ${label}`, async () => {
    await assert.rejects(worker(failure), (error: Error) => {
      assert.ok(error instanceof NativeSessionMethodError);
      assert.equal(error.code, (failure as Error & { code?: string }).code, 'not flattened');
      assert.equal(error.message, failure.message);
      return true;
    });
  });

  test(`the session route keeps the code of ${label}`, async () => {
    await assert.rejects(session(failure), (error: Error) => {
      assert.ok(error instanceof NativeSessionMethodError);
      assert.equal(error.code, (failure as Error & { code?: string }).code, 'not flattened');
      return true;
    });
  });
}

test('a refusal that is not a host failure still flattens to the generic code', async () => {
  await assert.rejects(worker(new Error('Native worker launch configuration is invalid')), {
    code: 'NATIVE_SESSION_ERROR',
  });
});

test('what each predicate admits, after the route has rebuilt the error', async () => {
  const routed = await worker(nativeHostUnavailableError('/root/host.log')).catch(
    (error: unknown) => error,
  );
  assert.equal((routed as NativeSessionMethodError).code, NATIVE_HOST_UNAVAILABLE);
  assert.equal(isNativeHostUnavailableError(routed), true, 'a launch may send again');
  assert.equal(isNativeHostNotReadyError(routed), true);
  const read = await worker(sourceUnavailable()).catch((error: unknown) => error);
  // A mutation is never replayed on this one: observation raises it after a read too.
  assert.equal(isNativeHostUnavailableError(read), false);
  assert.equal(isNativeHostNotReadyError(read), true, 'but a read may be probed again');
});
