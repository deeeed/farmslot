import { hasAuthErrorCode } from '../person-session-client.js';

/** One retry/liveness policy; platforms supply sockets and lifecycle/network wake events. */
export type GatewayRecoveryState = 'connecting' | 'connected' | 'disconnected';

export interface GatewayRecoveryOptions {
  enabled(): boolean;
  connect(): void;
  retire(): void;
  canProbe(): boolean;
  ping(): Promise<unknown>;
  onResponse?(latencyMs: number, completedAt: number): void;
}

export const GATEWAY_HEARTBEAT_MS = 30_000;
export const GATEWAY_CONNECT_DEADLINE_MS = 20_000;
export const GATEWAY_PING_DEADLINE_MS = 5_000;

/** Network and RPC timeouts never revoke a saved login or its cached observations. */
export function gatewayAuthenticationRefused(error: unknown): boolean {
  return [
    'AUTH_REQUIRED',
    'AUTH_FAILED',
    'AUTH_FORBIDDEN',
    'AUTH_PERSON_SESSION_REQUIRED',
    'AUTH_SESSION_ENDED',
  ].some((code) => hasAuthErrorCode(error, code));
}

export const GATEWAY_OFFLINE_LABEL = 'Gateway offline · Reconnecting…';

export function gatewayOfflineLabel(state: string, enabled: boolean): string | undefined {
  return enabled && state !== 'connected' ? GATEWAY_OFFLINE_LABEL : undefined;
}

export class GatewayRecovery {
  private state?: GatewayRecoveryState;
  private timer?: ReturnType<typeof setTimeout>;
  private delay = 1000;
  private generation = 0;
  private probing = false;
  private disposed = false;
  private lastWake = -Infinity;

  constructor(private readonly options: GatewayRecoveryOptions) {}

  update(state: GatewayRecoveryState): void {
    if (!this.enabled()) {
      this.reset();
      return;
    }
    if (state === this.state) return;
    this.cancel();
    this.state = state;
    if (state === 'connected') {
      this.delay = 1000;
      this.schedule(() => this.probe(), GATEWAY_HEARTBEAT_MS);
    } else if (state === 'connecting') {
      this.schedule(() => this.fail(), GATEWAY_CONNECT_DEADLINE_MS);
    } else {
      const delay = this.delay;
      this.delay = Math.min(delay * 2, 30_000);
      this.schedule(() => this.options.connect(), delay);
    }
  }

  /** Focus/visibility/network events bypass the wait, sharing one attempt or ping. */
  wake(): void {
    if (!this.enabled() || this.state === 'connecting' || this.probing) return;
    if (Date.now() - this.lastWake < 1000) return;
    this.lastWake = Date.now();
    if (this.state === 'connected') this.probe();
    else {
      this.cancel();
      this.state = undefined;
      this.options.connect();
    }
  }

  reset(): void {
    this.cancel();
    this.state = undefined;
    this.delay = 1000;
    this.lastWake = -Infinity;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private enabled(): boolean {
    return !this.disposed && this.options.enabled();
  }

  private probe(): void {
    if (!this.enabled() || this.state !== 'connected' || this.probing) return;
    if (!this.options.canProbe()) {
      this.schedule(() => this.probe(), GATEWAY_HEARTBEAT_MS);
      return;
    }
    this.cancel();
    this.probing = true;
    const startedAt = Date.now();
    this.lastWake = startedAt;
    const generation = this.generation;
    this.schedule(() => this.fail(), GATEWAY_PING_DEADLINE_MS);
    void this.options.ping().then(
      (reply) => {
        if (generation !== this.generation || !this.enabled()) return;
        if (!reply || typeof reply !== 'object' || Reflect.get(reply, 'ok') !== true) {
          this.fail();
          return;
        }
        this.probing = false;
        this.schedule(() => this.probe(), GATEWAY_HEARTBEAT_MS);
        this.options.onResponse?.(Date.now() - startedAt, Date.now());
      },
      () => {
        if (generation === this.generation && this.enabled()) this.fail();
      },
    );
  }

  private fail(): void {
    if (!this.enabled()) return;
    this.cancel();
    this.state = undefined;
    this.options.retire();
  }

  private schedule(callback: () => void, delay: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (generation === this.generation && this.enabled()) callback();
    }, delay);
    // Passive recovery must not keep a non-browser host alive by itself.
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  private cancel(): void {
    this.generation++;
    this.probing = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
