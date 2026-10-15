import {
  type GatewayAuthConnectResult,
  type GatewayPingResult,
  Methods,
  PersonSessionClient,
  PersonSessionEndedError,
  type RequestFrame,
} from '@farmslot/protocol';

import type { GatewayAuthCredentials } from './gateway-http-auth';
import { mobileGatewayProfileUrlError } from './gateway-profile-validation';

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
  const urlError = mobileGatewayProfileUrlError(url);
  if (urlError) return Promise.reject(new Error(urlError));

  const connectTimeout = timeouts.connectMs ?? CONNECTION_TEST_TIMEOUT;
  const pingTimeout = timeouts.pingMs ?? PING_TEST_TIMEOUT;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let authResult: GatewayAuthConnectResult | null = null;
    let accessToken = auth.token;
    let sessionRequestId = 0;
    const sessionRequests = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const ws = new WebSocket(url);
    let timer = setTimeout(() => {
      finishWithError(
        new Error(`Gateway did not connect and authenticate within ${connectTimeout}ms`),
      );
    }, connectTimeout);

    const person = auth.sessionStorage
      ? new PersonSessionClient({
          storage: auth.sessionStorage,
          request: (method, params) =>
            new Promise((resolve, reject) => {
              if (settled) {
                reject(new Error('Gateway connection test ended.'));
                return;
              }
              const id = `connection-test-session-${++sessionRequestId}`;
              sessionRequests.set(id, { resolve, reject });
              ws.send(JSON.stringify({ type: 'req', id, method, params }));
            }),
        })
      : null;
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      for (const request of sessionRequests.values())
        request.reject(new Error('Gateway connection test ended.'));
      sessionRequests.clear();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      return true;
    };

    const finishWithError = (error: Error) => {
      if (!finish()) return;
      reject(error);
    };

    const sendAuthentication = () => {
      if (settled) return;
      const frame: RequestFrame = {
        type: 'req',
        id: 'connection-test-auth',
        method: Methods.AUTH_CONNECT,
        params: {
          clientKind: 'companion',
          ...(accessToken ? { token: accessToken } : {}),
          ...(auth.password ? { password: auth.password } : {}),
        },
      };
      ws.send(JSON.stringify(frame));
    };
    ws.onopen = () => {
      if (!person) {
        sendAuthentication();
        return;
      }
      (async () => {
        await person.restore();
        if (person.session) accessToken = await person.accessToken(true);
        else if (auth.personSessionRequired && !auth.explicitPersonSignIn)
          throw new PersonSessionEndedError();
        sendAuthentication();
      })().catch((error: unknown) =>
        finishWithError(error instanceof Error ? error : new Error('Gateway sign-in failed.')),
      );
    };

    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        finishWithError(new Error('Gateway returned malformed JSON.'));
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
      const response = frame;
      if (typeof response.id !== 'string' || typeof response.ok !== 'boolean') {
        finishWithError(
          new Error(
            'Gateway returned a malformed response frame. Check the gateway version and update Farmslot.',
          ),
        );
        return;
      }
      const sessionRequest = sessionRequests.get(response.id);
      if (sessionRequest) {
        sessionRequests.delete(response.id);
        if (response.ok) sessionRequest.resolve(response.payload);
        else {
          const error = isRecord(response.error) ? response.error : {};
          sessionRequest.reject(
            Object.assign(
              new Error(
                typeof error.message === 'string' ? error.message : 'Gateway sign-in failed.',
              ),
              { code: error.code },
            ),
          );
        }
        return;
      }
      if (response.id !== 'connection-test-auth' && response.id !== 'connection-test-ping') {
        return;
      }
      if (!response.ok) {
        const body = isRecord(response.error) ? response.error : {};
        const error = Object.assign(
          new Error(
            typeof body.message === 'string' ? body.message : 'Gateway connection test failed',
          ),
          { code: body.code },
        );
        if (
          response.id === 'connection-test-auth' &&
          body.code === 'AUTH_PERSON_SESSION_REQUIRED'
        ) {
          if (auth.explicitPersonSignIn && auth.token && person) {
            person
              .exchange({
                credential: auth.token,
                deviceName: 'Mobile Companion',
                deviceKind: 'companion',
              })
              .then((token) => {
                accessToken = token;
                sendAuthentication();
              }, finishWithError);
          } else if (auth.sessionStorage) {
            auth.sessionStorage.save(null).then(() => finishWithError(error), finishWithError);
          } else finishWithError(error);
        } else finishWithError(error);
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
        if (response.payload.principal?.subjectKind === 'person' && !person?.session) {
          const error = new PersonSessionEndedError();
          if (!auth.explicitPersonSignIn && auth.sessionStorage)
            auth.sessionStorage.save(null).then(() => finishWithError(error), finishWithError);
          else finishWithError(error);
          return;
        }
        authResult = response.payload;
        if (!gatewaySupportsPing(authResult)) {
          if (!finish()) return;
          resolve({
            ...authResult,
            latencyMs: Date.now() - startedAt,
            gatewayPingSupported: false,
            compatibilityHint:
              authResult.capabilities.gatewayPing === false
                ? 'Connected; active ping checks are unavailable to this account.'
                : LEGACY_GATEWAY_COMPATIBILITY_HINT,
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

export function isGatewayAuthConnectResult(value: unknown): value is GatewayAuthConnectResult {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
