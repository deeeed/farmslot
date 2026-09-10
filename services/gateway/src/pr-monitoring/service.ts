import type {
  PRMonitor,
  PRMonitorConfig,
  PRMonitorLifecycle,
  PRMonitorObservation,
} from '@farmslot/protocol';

import { getQueueSnapshot } from '../backlog/dispatch-queue.js';

import { fetchPRMonitorObservation } from './github-observation.js';
import { type ManualRepairSelection, monitorRepairIsOpen } from './repair-plan.js';
import type { PRMonitorStore } from './store.js';

type Observer = (config: PRMonitorConfig, ownerId: string) => Promise<PRMonitorObservation>;

export class PRMonitoringService {
  private timer?: ReturnType<typeof setInterval>;
  private sweep?: Promise<void>;
  private readonly refreshing = new Map<string, Promise<PRMonitor>>();
  schedulerError?: string;

  constructor(
    readonly store: PRMonitorStore,
    private readonly authorized: (ownerId: string) => boolean,
    private readonly broadcast: (ownerId: string, monitor: PRMonitor) => void,
    private readonly observe: Observer = fetchPRMonitorObservation,
  ) {}

  start(): void {
    if (this.timer) return;
    const poll = () => {
      void this.tick().then(
        () => {
          this.schedulerError = undefined;
        },
        (error: unknown) => {
          // Persistence/system failures remain visible through status; the next sweep retries.
          // Provider failures are separately persisted on each monitor by refresh().
          this.schedulerError = error instanceof Error ? error.message : String(error);
        },
      );
    };
    this.timer = setInterval(poll, 30_000);
    this.timer.unref();
    poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(now = Date.now()): Promise<void> {
    if (this.sweep) return this.sweep;
    this.sweep = this.reconcileDue(now).finally(() => {
      this.sweep = undefined;
    });
    return this.sweep;
  }

  private async reconcileDue(now: number): Promise<void> {
    for (const monitor of this.store.snapshot().monitors) {
      if (
        monitor.lifecycle !== 'active' ||
        (monitor.nextCheckAt && Date.parse(monitor.nextCheckAt) > now)
      )
        continue;
      await this.refresh(monitor.id, monitor.ownerId);
    }
  }

  async subscribe(
    ownerId: string,
    config: PRMonitorConfig,
    originatingRunId?: string,
  ): Promise<PRMonitor> {
    this.assertAuthorized(ownerId);
    const monitor = await this.store.subscribe(ownerId, config, originatingRunId);
    this.broadcast(ownerId, monitor);
    // Initial enrollment shows existing evidence, and does not defer it until the next tick.
    return monitor.lifecycle === 'active' ? this.refresh(monitor.id, ownerId) : monitor;
  }

  async configure(
    id: string,
    ownerId: string,
    revision: number,
    config: PRMonitorConfig,
  ): Promise<PRMonitor> {
    this.assertAuthorized(ownerId);
    const monitor = await this.store.configure(id, ownerId, revision, config);
    this.broadcast(ownerId, monitor);
    return config.policy.mode === 'automatic-repair' && monitor.lifecycle === 'active'
      ? this.refresh(id, ownerId)
      : monitor;
  }

  async lifecycle(
    id: string,
    ownerId: string,
    revision: number,
    lifecycle: Exclude<PRMonitorLifecycle, 'finished'>,
  ): Promise<PRMonitor> {
    this.assertAuthorized(ownerId);
    const monitor = await this.store.setLifecycle(id, ownerId, revision, lifecycle);
    this.broadcast(ownerId, monitor);
    return monitor;
  }

  async acknowledge(
    id: string,
    ownerId: string,
    revision: number,
    incidentId: string,
    snoozedUntil?: string,
  ): Promise<PRMonitor> {
    this.assertAuthorized(ownerId);
    const monitor = await this.store.acknowledge(id, ownerId, revision, incidentId, snoozedUntil);
    this.broadcast(ownerId, monitor);
    return monitor;
  }

  refresh(id: string, ownerId: string): Promise<PRMonitor> {
    this.store.get(id, ownerId);
    const key = `${ownerId}:${id}`;
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const promise = this.refreshOnce(id, ownerId).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, promise);
    return promise;
  }

  private async refreshOnce(id: string, ownerId: string): Promise<PRMonitor> {
    const monitor = this.store.get(id, ownerId);
    if (monitor.lifecycle !== 'active') return monitor;
    let result: { observation: PRMonitorObservation } | { error: string; checkedAt: string };
    try {
      this.assertAuthorized(ownerId);
      result = { observation: await this.observe(monitor.config, ownerId) };
      // Revocation while GitHub was responding must prevent publishing fresh private facts.
      this.assertAuthorized(ownerId);
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
    const updated = await this.store.observe(
      id,
      ownerId,
      monitor.revision,
      result,
      monitor.observationGeneration ?? 0,
    );
    if (updated) this.broadcast(ownerId, updated);
    return updated ?? this.store.get(id, ownerId);
  }

  private assertAuthorized(ownerId: string): void {
    if (!this.authorized(ownerId))
      throw new Error('Subscription owner no longer has monitoring authority');
  }

  async requestRepair(
    id: string,
    ownerId: string,
    revision: number,
    selection: ManualRepairSelection,
  ): Promise<PRMonitor> {
    this.assertAuthorized(ownerId);
    const before = this.store.get(id, ownerId);
    if (before.revision !== revision)
      throw new Error('Monitor changed; refresh before requesting repair');
    await this.refresh(id, ownerId);
    const current = this.store.get(id, ownerId);
    if (JSON.stringify(current.config) !== JSON.stringify(before.config))
      throw new Error(
        'Monitor policy changed while refreshing; review it before requesting repair',
      );
    const repair = await this.store.ensureRepair(id, ownerId, selection, () => {
      const active = this.store.get(id, ownerId).repairs?.find(monitorRepairIsOpen);
      if (
        active?.runId ||
        getQueueSnapshot().some(
          (item) => item.prWork?.sourceId === id && item.status === 'dispatching',
        )
      )
        throw new Error('A repair is already starting or running; use its linked run controls');
    });
    if (!repair) throw new Error('No fresh unresolved incidents are available for repair');
    const result = this.store.get(id, ownerId);
    this.broadcast(ownerId, result);
    return result;
  }

  async enrolled(id: string, ownerId: string): Promise<PRMonitor> {
    this.assertAuthorized(ownerId);
    const monitor = this.store.get(id, ownerId);
    this.broadcast(ownerId, monitor);
    return monitor.lifecycle === 'active' ? this.refresh(id, ownerId) : monitor;
  }
}
