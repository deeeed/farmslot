import {
  type Frame,
  type GatewayAuthConnectResult,
  type GatewayPingResult,
  Methods,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import type { GatewayAuthCredentials } from './gateway-http-auth';

export interface GatewayConnectionTestResult extends GatewayAuthConnectResult {
  latencyMs: number;
}

export interface GatewayConnectionTestTimeouts {
  connectMs?: number;
  pingMs?: number;
}

const CONNECTION_TEST_TIMEOUT = 30_000;

export function testGatewayConnection(
  url: string,
  auth: GatewayAuthCredentials = {},
  timeouts: GatewayConnectionTestTimeouts = {},
): Promise<GatewayConnectionTestResult> {
  const connectTimeout = timeouts.connectMs ?? CONNECTION_TEST_TIMEOUT;
  const pingTimeout = timeouts.pingMs ?? CONNECTION_TEST_TIMEOUT;
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
      let frame: Frame;
      try {
        frame = JSON.parse(ev.data as string) as Frame;
      } catch (error) {
        finishWithError(new Error(`Gateway returned malformed JSON: ${errorMessage(error)}`));
        return;
      }
      if (frame.type !== 'res') return;
      const response = frame as ResponseFrame;
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
        authResult = response.payload as GatewayAuthConnectResult;
        if (!authResult.ok) {
          finishWithError(new Error('Gateway authentication failed'));
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
      const pingResult = response.payload as Partial<GatewayPingResult> | undefined;
      if (
        pingResult?.ok !== true ||
        typeof pingResult.serverTimeMs !== 'number' ||
        !Number.isFinite(pingResult.serverTimeMs)
      ) {
        finishWithError(new Error('Gateway returned an invalid ping response'));
        return;
      }
      if (!finish()) return;
      resolve({
        ...authResult,
        latencyMs: Date.now() - startedAt,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
