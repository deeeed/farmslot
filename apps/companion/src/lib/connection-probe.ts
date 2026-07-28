import { type GatewayPingResult, Methods } from '@farmslot/protocol';

import type { ConnectionState } from './gateway-client';
import {
  type GatewayConnectionTestResult,
  isValidGatewayPingResult,
  testGatewayConnection,
} from './gateway-connection-test';
import type { GatewayAuthCredentials } from './gateway-http-auth';

export type ConnectionProbeResult = { ok: true; latencyMs: number } | { ok: false; error: string };

export interface ConnectionProbeClient {
  connectionState: ConnectionState;
  gatewayPingSupported: boolean | null;
  request<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T>;
}

interface RunConnectionProbeOptions {
  client: ConnectionProbeClient;
  gatewayUrl: string;
  auth: GatewayAuthCredentials;
  appActive: boolean;
  timeoutMs: number;
  isCurrent: () => boolean;
  testConnection?: typeof testGatewayConnection;
  now?: () => number;
}

export interface ConnectionProbeOutcome {
  result: ConnectionProbeResult;
  compatibilityHint: string | null;
  activeTransportProven: boolean;
}

const SUPERSEDED_PROBE_ERROR = 'Gateway profile changed while testing.';

export async function runConnectionProbe({
  client,
  gatewayUrl,
  auth,
  appActive,
  timeoutMs,
  isCurrent,
  testConnection = testGatewayConnection,
  now = Date.now,
}: RunConnectionProbeOptions): Promise<ConnectionProbeOutcome> {
  const startedAt = now();

  if (!appActive || client.gatewayPingSupported !== true) {
    const result: GatewayConnectionTestResult = await testConnection(gatewayUrl, auth, {
      connectMs: timeoutMs,
      pingMs: timeoutMs,
    });
    if (!isCurrent()) return supersededProbeOutcome();
    return {
      result: { ok: true, latencyMs: result.latencyMs },
      compatibilityHint: result.compatibilityHint ?? null,
      activeTransportProven: appActive && client.connectionState === 'connected',
    };
  }

  const pingResult = await client.request<GatewayPingResult>(Methods.GATEWAY_PING, {}, timeoutMs);
  if (!isValidGatewayPingResult(pingResult)) {
    throw new Error('Gateway returned an invalid ping response');
  }
  if (!isCurrent()) return supersededProbeOutcome();
  return {
    result: { ok: true, latencyMs: now() - startedAt },
    compatibilityHint: null,
    activeTransportProven: true,
  };
}

function supersededProbeOutcome(): ConnectionProbeOutcome {
  return {
    result: { ok: false, error: SUPERSEDED_PROBE_ERROR },
    compatibilityHint: null,
    activeTransportProven: false,
  };
}
