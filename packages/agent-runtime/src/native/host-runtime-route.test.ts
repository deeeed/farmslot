import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Methods } from '@farmslot/protocol/rpc';

import { NativeSessionClient } from './client.js';
import { routeNativeSession } from './service.js';
import { routeNativeWorkerSession } from './worker-service.js';

test('ordinary and worker routes preserve native runtime skew', async (t) => {
  const client = new NativeSessionClient('/unused-native-skew-route');
  const refuse = async () => {
    throw Object.assign(new Error('Native host runtime version skew'), {
      code: 'NATIVE_HOST_VERSION_SKEW',
    });
  };
  t.mock.method(client, 'create', refuse);
  t.mock.method(client, 'ensureWorker', refuse);
  await assert.rejects(
    routeNativeSession(client, 'owner', Methods.NATIVE_SESSION_CREATE, {
      runner: 'codex',
      cwd: '/tmp',
    }),
    { code: 'NATIVE_HOST_VERSION_SKEW' },
  );
  await assert.rejects(
    routeNativeWorkerSession(client, 'owner', 'native.worker.ensure', {
      runner: 'codex',
      cwd: '/tmp',
      sessionId: randomUUID(),
      launch: {
        leaseId: randomUUID(),
        safetyTier: 'sandboxed',
        environment: { set: {}, unset: [] },
      },
    }),
    { code: 'NATIVE_HOST_VERSION_SKEW' },
  );
});
