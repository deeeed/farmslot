import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods } from '@farmslot/protocol';

import { type ConnectionProbeClient, runConnectionProbe } from './connection-probe';
import { LEGACY_GATEWAY_COMPATIBILITY_HINT } from './gateway-connection-test';

function connectionResult(
  latencyMs: number,
  gatewayPingSupported: boolean,
  compatibilityHint?: string,
) {
  return {
    ok: true as const,
    clientKind: 'companion' as const,
    authMode: 'token' as const,
    authenticatedAt: 1,
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      ...(gatewayPingSupported ? { gatewayPing: true } : {}),
    },
    gatewayPingSupported,
    latencyMs,
    ...(compatibilityHint ? { compatibilityHint } : {}),
  };
}

function client(
  capability: boolean | null,
  connectionState: ConnectionProbeClient['connectionState'] = 'connected',
): ConnectionProbeClient {
  return {
    connectionState,
    gatewayPingSupported: capability,
    request: async () => {
      throw new Error('direct ping should not be used');
    },
  };
}

test('legacy startup performs bounded fresh authentication before reporting liveness', async () => {
  const calls: Array<{ url: string; auth: unknown; timeouts: unknown }> = [];
  const result = await runConnectionProbe({
    client: client(null, 'connecting'),
    gatewayUrl: 'ws://gateway.test/ws',
    auth: { token: 'token-a' },
    appActive: true,
    timeoutMs: 1_234,
    isCurrent: () => true,
    testConnection: async (url, auth, timeouts) => {
      calls.push({ url, auth, timeouts });
      return connectionResult(42, false, LEGACY_GATEWAY_COMPATIBILITY_HINT);
    },
  });

  assert.deepEqual(calls, [
    {
      url: 'ws://gateway.test/ws',
      auth: { token: 'token-a' },
      timeouts: { connectMs: 1_234, pingMs: 1_234 },
    },
  ]);
  assert.deepEqual(result, {
    result: { ok: true, latencyMs: 42 },
    compatibilityHint: LEGACY_GATEWAY_COMPATIBILITY_HINT,
    activeTransportProven: false,
  });
});

test('legacy retry performs fresh authentication again and reports offline failures', async () => {
  let attempts = 0;
  const options = {
    client: client(false),
    gatewayUrl: 'ws://legacy.test/ws',
    auth: {},
    appActive: true,
    timeoutMs: 500,
    isCurrent: () => true,
    testConnection: async () => {
      attempts += 1;
      if (attempts === 2) throw new Error('Gateway socket error during connection test');
      return connectionResult(17, false);
    },
  };

  assert.equal((await runConnectionProbe(options)).result.ok, true);
  await assert.rejects(() => runConnectionProbe(options), /Gateway socket error/);
  assert.equal(attempts, 2);
});

test('inactive manual probe uses fresh authentication without proving the paused transport', async () => {
  const outcome = await runConnectionProbe({
    client: client(true),
    gatewayUrl: 'ws://gateway.test/ws',
    auth: {},
    appActive: false,
    timeoutMs: 500,
    isCurrent: () => true,
    testConnection: async () => connectionResult(12, true),
  });

  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.activeTransportProven, false);
});

test('profile switch supersedes an old credential probe without returning stale success', async () => {
  let current = true;
  const pending = Promise.withResolvers<ReturnType<typeof connectionResult>>();
  const probe = runConnectionProbe({
    client: client(false),
    gatewayUrl: 'ws://old.test/ws',
    auth: { token: 'old-token' },
    appActive: true,
    timeoutMs: 500,
    isCurrent: () => current,
    testConnection: () => pending.promise,
  });

  current = false;
  pending.resolve(connectionResult(8, false));

  assert.deepEqual((await probe).result, {
    ok: false,
    error: 'Gateway profile changed while testing.',
  });
});

test('confirmed modern sessions use gateway.ping directly', async () => {
  const methods: string[] = [];
  const modernClient: ConnectionProbeClient = {
    connectionState: 'connected',
    gatewayPingSupported: true,
    request: async (method) => {
      methods.push(method);
      return { ok: true, serverTimeMs: 123 } as never;
    },
  };

  const outcome = await runConnectionProbe({
    client: modernClient,
    gatewayUrl: 'ws://gateway.test/ws',
    auth: {},
    appActive: true,
    timeoutMs: 500,
    isCurrent: () => true,
    now: (() => {
      const values = [100, 109];
      return () => values.shift() ?? 109;
    })(),
  });

  assert.deepEqual(methods, [Methods.GATEWAY_PING]);
  assert.deepEqual(outcome.result, { ok: true, latencyMs: 9 });
});
