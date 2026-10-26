/**
 * A fake gateway for node tests of the browser gateway client. It installs a WebSocket
 * that answers only `auth.connect`, plus the browser globals the client reads, and
 * restores the real globals when the test ends. Other requests stay unanswered.
 */

import type { TestContext } from 'node:test';

import type { RequestFrame } from '@farmslot/protocol';

export interface FakeGatewaySocket {
  readyState: number;
  readonly sent: Array<{ id: string; method: string }>;
  response(id: string, payload: unknown, resourceState?: unknown): void;
  failure(id: string, error: { code: string; message: string }): void;
  event(event: string, payload: unknown): void;
}

interface FakeGatewayRequest {
  id: string;
  method: string;
  params?: unknown;
}
interface FakeGatewayResponse {
  payload: unknown;
  resourceState?: unknown;
}

export interface FakeGateway {
  authPayload?: unknown;
  resourceEpoch?: string;
  responseForRequest?: (request: FakeGatewayRequest) => FakeGatewayResponse | undefined;
  beforeRestore?: () => void | Promise<void>;
  /** Every socket the client opened, oldest first. */
  readonly sockets: FakeGatewaySocket[];
  /** Tokens presented to `auth.connect`, in order. */
  readonly tokens: unknown[];
  /** Browser localStorage contents. */
  readonly store: Map<string, string>;
  readonly requests: RequestFrame[];
  respond(method: string, payload: unknown): void;
  /** Leave `auth.connect` unanswered, as a gateway restarting mid-handshake does. */
  holdAuth: boolean;
  /** Principal id that the next `auth.connect` reply carries. */
  principalId: string;
  /** Close the newest socket the way a gateway restart does. */
  restart(): void;
}

const GLOBAL_KEYS = [
  'window',
  'localStorage',
  'location',
  'document',
  'history',
  'WebSocket',
  'BroadcastChannel',
] as const;

export function installFakeGateway(t: TestContext, principalId = 'operator'): FakeGateway {
  const descriptors = GLOBAL_KEYS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const sockets: Socket[] = [];
  const fake: FakeGateway = {
    sockets,
    tokens: [],
    store: new Map<string, string>(),
    requests: [],
    respond: (method, payload) => {
      const request = [...fake.requests].reverse().find((frame) => frame.method === method);
      if (!request) throw new Error(`No pending ${method} request`);
      sockets.at(-1)!.respond(request.id, payload);
    },
    holdAuth: false,
    principalId,
    restart: () => sockets.at(-1)!.gatewayRestart(),
  };

  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    readonly sent: Array<{ id: string; method: string }> = [];
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(text: string) {
      const request: RequestFrame = JSON.parse(text);
      this.sent.push({ id: request.id, method: request.method });
      fake.requests.push(request);
      if (request.method !== 'auth.connect') {
        const response = fake.responseForRequest?.(request);
        if (response)
          queueMicrotask(() => this.response(request.id, response.payload, response.resourceState));
        return;
      }
      const params = request.params;
      fake.tokens.push(
        params && typeof params === 'object' && 'token' in params ? params.token : undefined,
      );
      if (fake.holdAuth) return;
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'res',
              id: request.id,
              ok: true,
              payload: fake.authPayload ?? {
                ok: true,
                ...(fake.resourceEpoch ? { authMode: 'token' } : {}),
                capabilities: {
                  workspaceAccess: 'farm',
                  ...(fake.resourceEpoch
                    ? {
                        resourceChanges: {
                          version: 1,
                          epoch: fake.resourceEpoch,
                          versionLists: false,
                          observedReads: 1,
                        },
                      }
                    : {}),
                },
                principal: {
                  id: fake.principalId,
                  ...(fake.resourceEpoch ? { generation: 0 } : {}),
                  subjectKind: 'service',
                  displayName: fake.principalId,
                  roles: [{ role: 'admin', scope: { kind: 'global' } }],
                },
              },
            }),
          }),
        ),
      );
    }
    close() {
      this.readyState = 3;
    }
    response(id: string, payload: unknown, resourceState?: unknown) {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'res',
            id,
            ok: true,
            payload,
            resourceState,
          }),
        }),
      );
    }
    failure(id: string, error: { code: string; message: string }) {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'res', id, ok: false, error }),
        }),
      );
    }
    event(event: string, payload: unknown) {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'event', event, payload, seq: 1 }),
        }),
      );
    }
    respond(id: string, payload: unknown) {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'res', id, ok: true, payload }),
        }),
      );
    }
    gatewayRestart() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }

  const values = {
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    localStorage: {
      getItem: (key: string) => fake.store.get(key) ?? null,
      setItem: (key: string, value: string) => fake.store.set(key, value),
      removeItem: (key: string) => fake.store.delete(key),
    },
    location: { protocol: 'http:', host: 'localhost:1234', hash: '', hostname: 'localhost' },
    document: Object.assign(new EventTarget(), { cookie: '', visibilityState: 'visible' }),
    history: { replaceState: () => {} },
    WebSocket: Socket,
    BroadcastChannel: undefined,
  };
  for (const key of GLOBAL_KEYS)
    Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
  t.after(async () => {
    await fake.beforeRestore?.();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return fake;
}
