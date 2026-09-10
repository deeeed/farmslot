import type { ReactiveController, ReactiveControllerHost } from 'lit';

import {
  Events,
  Methods,
  type PRPushListResult,
  type PRRulesListResult,
  type PRWatchListResult,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getState, subscribe } from '../../state.js';

export class PRAutomationController implements ReactiveController {
  monitors: PRWatchListResult = { monitors: [] };
  reviews: PRRulesListResult = { teams: [], rules: [], intents: [] };
  push: PRPushListResult = { attention: [], devices: [], deliveries: [] };
  error = '';
  actionError = '';
  loading = false;
  busy = false;
  private pending?: Promise<void>;
  private dirty = false;
  private active = false;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }
  get connected(): boolean {
    return gateway.connectionState === 'connected';
  }
  get slots() {
    return getState().fleet?.slots ?? [];
  }
  get projects(): string[] {
    return [...new Set(this.slots.map((slot) => slot.project))].sort();
  }

  hostConnected(): void {
    this.active = true;
    this.unsubscribers = [
      ...[
        Events.PR_WATCH_UPDATED,
        Events.PR_WATCH_POLICY_UPDATED,
        Events.PR_RULES_UPDATED,
        Events.PR_PUSH_UPDATED,
      ].map((event) => gateway.subscribe(event, () => void this.refresh())),
      subscribe(() => this.host.requestUpdate()),
      gateway.onConnectionChange(() => {
        this.push = { attention: [], devices: [], deliveries: [] };
        this.monitors = { monitors: [] };
        this.reviews = { teams: [], rules: [], intents: [] };
        this.error = '';
        this.host.requestUpdate();
        if (this.connected) void this.refresh();
      }),
    ];
    if (this.connected) void this.refresh();
  }
  hostDisconnected(): void {
    this.active = false;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }
  refresh(): Promise<void> {
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async read(): Promise<void> {
    while (this.dirty && this.active && this.connected) {
      this.dirty = false;
      this.loading = true;
      this.host.requestUpdate();
      const epoch = gateway.connectionEpoch;
      const [monitors, reviews, push] = await Promise.allSettled([
        gateway.request<PRWatchListResult>(Methods.PR_WATCH_LIST, {}),
        gateway.request<PRRulesListResult>(Methods.PR_RULES_LIST, {}),
        gateway.request<PRPushListResult>(Methods.PR_PUSH_LIST, {}),
      ]);
      if (!this.active || epoch !== gateway.connectionEpoch) continue;
      const errors: string[] = [];
      if (monitors.status === 'fulfilled') this.monitors = monitors.value;
      else errors.push(`Monitors: ${String(monitors.reason)}`);
      if (reviews.status === 'fulfilled') this.reviews = reviews.value;
      else errors.push(`Review intake: ${String(reviews.reason)}`);
      if (push.status === 'fulfilled') this.push = push.value;
      else errors.push(`Notifications: ${String(push.reason)}`);
      this.error = errors.join('; ');
      this.loading = false;
      this.host.requestUpdate();
    }
    this.loading = false;
  }
  async mutate<T>(method: string, params: unknown): Promise<T | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    this.actionError = '';
    this.host.requestUpdate();
    try {
      const result = await gateway.request<T>(method, params, 120_000);
      await this.refresh();
      return result;
    } catch (error) {
      // Keep form values available for retry and show the gateway's actionable failure.
      this.actionError = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      this.busy = false;
      this.host.requestUpdate();
    }
  }
}
