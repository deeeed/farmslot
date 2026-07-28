import {
  type GatewayAuthConnectResult,
  type GatewayPingResult,
  Methods,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import type { GatewayAuthCredentials } from './gateway-http-auth';

export interface GatewayConnectionTestResult extends GatewayAuthConnectResult {
  latencyMs: number;
  gatewayPingSupported: boolean;
  compatibilityHint?: string;
}

export interface GatewayConnectionTestTimeouts {
  connectMs?: number;
  pingMs?: number;
}

export const LEGACY_GATEWAY_COMPATIBILITY_HINT =
  'Connected to an older gateway without gateway.ping; update Farmslot for active liveness checks.';

const CONNECTION_TEST_TIMEOUT = 8_000;
const PING_TEST_TIMEOUT = 5_000;

export function testGatewayConnection(
  url: string,
  auth: GatewayAuthCredentials = {},
  timeouts: GatewayConnectionTestTimeouts = {},
): Promise<GatewayConnectionTestResult> {
  const connectTimeout = timeouts.connectMs ?? CONNECTION_TEST_TIMEOUT;
  const pingTimeout = timeouts.pingMs ?? PING_TEST_TIMEOUT;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let authResult: GatewayAuthConnectResult | null = null;
    const ws = new WebSocket(url);
    let timer = setTimeout(() => {
      finishWithError(
        new Error(`Gateway did not connect and authenticate within ${connectTimeout}ms`),
      );
    }, connectTimeout);

    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      return true;
    };

    const finishWithError = (error: Error) => {
      if (!finish()) return;
      reject(error);
    };

    ws.onopen = () => {
      const frame: RequestFrame = {
        type: 'req',
        id: 'connection-test-auth',
        method: Methods.AUTH_CONNECT,
        params: {
          clientKind: 'companion',
          ...auth,
        },
      };
      ws.send(JSON.stringify(frame));
    };

    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string) as unknown;
      } catch (error) {
        finishWithError(new Error(`Gateway returned malformed JSON: ${errorMessage(error)}`));
        return;
      }
      if (!isRecord(parsed)) {
        finishWithError(
          new Error(
            'Gateway returned a malformed response frame. Check the gateway version and update Farmslot.',
          ),
        );
        return;
      }
      const frame = parsed;
      if (frame.type === 'event') return;
      if (frame.type !== 'res') {
        finishWithError(
          new Error(
            'Gateway returned a malformed response frame. Check the gateway version and update Farmslot.',
          ),
        );
        return;
      }
      const response = frame as unknown as ResponseFrame;
      if (typeof response.id !== 'string' || typeof response.ok !== 'boolean') {
        finishWithError(
          new Error(
            'Gateway returned a malformed response frame. Check the gateway version and update Farmslot.',
          ),
        );
        return;
      }
      if (response.id !== 'connection-test-auth' && response.id !== 'connection-test-ping') {
        return;
      }
      if (!response.ok) {
        finishWithError(
          new Error(
            response.error?.message ??
              (response.id === 'connection-test-auth'
                ? 'Gateway authentication failed'
                : 'Gateway ping failed'),
          ),
        );
        return;
      }
      if (response.id === 'connection-test-auth') {
        if (isRecord(response.payload) && response.payload.ok === false) {
          finishWithError(new Error('Gateway authentication failed'));
          return;
        }
        if (!isGatewayAuthConnectResult(response.payload)) {
          finishWithError(
            new Error(
              'Gateway returned a malformed authentication response. Check the gateway version and update Farmslot.',
            ),
          );
          return;
        }
        authResult = response.payload;
        if (!gatewaySupportsPing(authResult)) {
          if (!finish()) return;
          resolve({
            ...authResult,
            latencyMs: Date.now() - startedAt,
            gatewayPingSupported: false,
            compatibilityHint: LEGACY_GATEWAY_COMPATIBILITY_HINT,
          });
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          finishWithError(new Error(`Gateway ping timed out after ${pingTimeout}ms`));
        }, pingTimeout);
        const pingFrame: RequestFrame = {
          type: 'req',
          id: 'connection-test-ping',
          method: Methods.GATEWAY_PING,
          params: {},
        };
        ws.send(JSON.stringify(pingFrame));
        return;
      }
      if (!authResult) {
        finishWithError(new Error('Gateway returned ping before authentication completed'));
        return;
      }
      if (!isValidGatewayPingResult(response.payload)) {
        finishWithError(new Error('Gateway returned an invalid ping response'));
        return;
      }
      if (!finish()) return;
      resolve({
        ...authResult,
        latencyMs: Date.now() - startedAt,
        gatewayPingSupported: true,
      });
    };

    ws.onerror = () => {
      finishWithError(new Error('Gateway socket error during connection test'));
    };

    ws.onclose = () => {
      if (settled) return;
      finishWithError(new Error('Gateway closed before authenticated ping completed'));
    };
  });
}

export function gatewaySupportsPing(result: GatewayAuthConnectResult): boolean {
  return result.capabilities?.gatewayPing === true;
}

function isGatewayAuthConnectResult(value: unknown): value is GatewayAuthConnectResult {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.capabilities)) return false;
  return (
    (value.clientKind === 'ui' ||
      value.clientKind === 'companion' ||
      value.clientKind === 'node') &&
    (value.authMode === 'none' || value.authMode === 'token' || value.authMode === 'password') &&
    typeof value.authenticatedAt === 'number' &&
    Number.isFinite(value.authenticatedAt) &&
    typeof value.capabilities.httpBearerAuth === 'boolean' &&
    typeof value.capabilities.voiceInstructionFormatting === 'boolean' &&
    (value.capabilities.gatewayPing === undefined ||
      typeof value.capabilities.gatewayPing === 'boolean')
  );
}

export function isValidGatewayPingResult(value: unknown): value is GatewayPingResult {
  const result = value as Partial<GatewayPingResult> | undefined;
  return (
    result?.ok === true &&
    typeof result.serverTimeMs === 'number' &&
    Number.isFinite(result.serverTimeMs)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
