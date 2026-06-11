import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket as NodeWebSocket } from 'ws';

import type { EventFrame } from '@farmslot/protocol';

export interface GatewayClientOpts {
  url: string;
  timeout: number;
  /** Profile credential (ADR-036); takes precedence over env/.env discovery. */
  credential?: GatewayCredential;
}

interface GatewayCredential {
  token?: string;
  password?: string;
}

export class GatewayClient {
  private url: string;
  private timeout: number;
  private credential: GatewayCredential | null;

  constructor(opts: GatewayClientOpts) {
    this.url = opts.url;
    this.timeout = opts.timeout;
    this.credential = opts.credential ?? resolveGatewayCredential();
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    return this.callWithEvents<T>(method, params);
  }

  async callWithEvents<T = unknown>(
    method: string,
    params: unknown = {},
    onEvent?: (event: EventFrame) => void,
  ): Promise<T> {
    const reqId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    return new Promise<T>((resolve, reject) => {
      const WebSocketCtor = globalThis.WebSocket ?? NodeWebSocket;
      const ws = new WebSocketCtor(this.url);
      let done = false;
      let timer: ReturnType<typeof setTimeout>;

      // Reset timeout on any activity — keeps streaming ops alive.
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!done) {
            done = true;
            ws.close();
            reject(new Error(`Timeout — no activity for ${this.timeout}ms`));
          }
        }, this.timeout);
      };

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
        ws.close();
      };

      const sendRequest = () => {
        ws.send(JSON.stringify({ type: 'req', id: reqId, method, params }));
      };

      const authId = `${reqId}-auth`;
      let authPending = false;

      ws.addEventListener('open', () => {
        resetTimer();
        if (this.credential?.token || this.credential?.password) {
          authPending = true;
          ws.send(
            JSON.stringify({
              type: 'req',
              id: authId,
              method: 'auth.connect',
              params: {
                clientKind: 'ui',
                clientName: 'farmslot-cli',
                ...(this.credential.token ? { token: this.credential.token } : {}),
                ...(this.credential.password ? { password: this.credential.password } : {}),
              },
            }),
          );
          return;
        }
        sendRequest();
      });

      ws.addEventListener('message', (evt) => {
        resetTimer();
        let frame: any;
        try {
          frame = JSON.parse(String(evt.data));
        } catch {
          return;
        }

        if (frame.type === 'event') {
          if (onEvent) onEvent(frame as EventFrame);
          return;
        }

        if (frame.type !== 'res') return;

        if (authPending && frame.id === authId) {
          authPending = false;
          if (frame.ok) {
            sendRequest();
          } else {
            finish(() =>
              reject(new Error(frame.error?.message || 'Gateway authentication failed')),
            );
          }
          return;
        }

        if (frame.id !== reqId) return;

        if (frame.ok) {
          finish(() => resolve(frame.payload as T));
        } else {
          finish(() => reject(new Error(frame.error?.message || 'Unknown gateway error')));
        }
      });

      ws.addEventListener('error', () => {
        finish(() => reject(new Error('Connection failed — is the gateway running?')));
      });

      ws.addEventListener('close', () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(new Error('Connection closed unexpectedly'));
        }
      });
    });
  }
}

function resolveGatewayCredential(): GatewayCredential | null {
  const envCredential = credentialFromEnv(process.env);
  if (envCredential) return envCredential;

  for (const envFile of findGatewayEnvFiles()) {
    const parsed = readEnvFile(envFile);
    const credential = credentialFromEnv(parsed);
    if (credential) return credential;
  }

  return null;
}

function credentialFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string>,
): GatewayCredential | null {
  const password = nonEmpty(env.FARMSLOT_GATEWAY_PASSWORD);
  if (password) return { password };
  const token = nonEmpty(env.FARMSLOT_GATEWAY_TOKEN);
  if (token) return { token };
  return null;
}

function findGatewayEnvFiles(): string[] {
  const roots = new Set<string>();
  if (process.env.FARMSLOT_ROOT) roots.add(resolve(process.env.FARMSLOT_ROOT));

  let cwd = resolve(process.cwd());
  while (true) {
    roots.add(cwd);
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }

  // Source path: <repo>/packages/cli/src/gateway-client.ts.
  // Built path, if introduced later: <repo>/packages/cli/dist/…
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  roots.add(resolve(sourceDir, '../../..'));

  const files: string[] = [];
  for (const root of roots) {
    for (const name of ['.env.local-auth', '.env']) {
      const file = resolve(root, name);
      if (existsSync(file) && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function readEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eqIdx = normalized.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = normalized.slice(0, eqIdx).trim();
    let value = normalized.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
