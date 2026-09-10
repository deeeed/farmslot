import type {
  PRPushAttention,
  PRPushDelivery,
  PRPushListResult,
  PRPushRegisterParams,
} from '@farmslot/protocol';

import { ExpoPushProvider, type PRPushProvider, type PushResult } from './expo.js';
import { PRPushStore, publicDevice, type StoredPushDevice } from './store.js';

type SourceReader = (principalId: string) => PRPushAttention[];
export class PRPushService {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  schedulerError?: string;
  private readonly published = new Map<string, string>();
  constructor(
    readonly store: PRPushStore,
    private readonly authorized: (id: string) => boolean,
    private readonly sources: SourceReader,
    private readonly provider: PRPushProvider = new ExpoPushProvider(),
    private readonly changed?: (id: string, value: PRPushListResult) => void,
    private readonly audience: () => string[] = () => [],
    private readonly acknowledgeSource?: (ownerId: string, sourceId: string) => Promise<void>,
  ) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref();
    this.wake();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  wake(): void {
    void this.tick().then(
      () => {
        this.schedulerError = undefined;
      },
      (error: unknown) => {
        // Keep the durable inbox and surface the scheduler failure; the next sweep retries.
        this.schedulerError = error instanceof Error ? error.message : String(error);
      },
    );
  }
  attention(ownerId: string): PRPushAttention[] {
    if (!this.authorized(ownerId)) return [];
    return this.sources(ownerId).map((source) => ({
      ...source,
      acknowledgedAt: source.acknowledgedAt ?? this.store.acknowledgement(ownerId, source.id),
    }));
  }
  list(ownerId: string): PRPushListResult {
    if (!this.authorized(ownerId)) throw new Error('Notification access was revoked');
    const data = this.store.snapshot();
    const devices = data.devices.filter((device) => device.ownerId === ownerId);
    return {
      attention: this.attention(ownerId),
      devices: devices.map(publicDevice),
      deliveries: data.deliveries.filter((delivery) =>
        devices.some((device) => device.id === delivery.deviceId),
      ),
      schedulerError: this.schedulerError,
    };
  }
  async register(ownerId: string, params: PRPushRegisterParams) {
    const device = await this.store.register(ownerId, params, () => this.authorized(ownerId));
    this.notify(ownerId);
    return device;
  }
  async acknowledge(ownerId: string, sourceId: string): Promise<void> {
    if (!this.attention(ownerId).some((item) => item.id === sourceId))
      throw new Error('Notification is unavailable');
    await this.acknowledgeSource?.(ownerId, sourceId);
    await this.store.acknowledge(ownerId, sourceId, () =>
      this.attention(ownerId).some((item) => item.id === sourceId),
    );
    this.notify(ownerId);
  }
  async unregister(ownerId: string, installationId: string): Promise<void> {
    await this.store.disable(ownerId, installationId);
    this.notify(ownerId);
  }
  private notify(ownerId: string): void {
    if (!this.changed) return;
    const result = this.authorized(ownerId)
      ? this.list(ownerId)
      : { attention: [], devices: [], deliveries: [] };
    const encoded = JSON.stringify(result);
    if (this.published.get(ownerId) === encoded) return;
    this.published.set(ownerId, encoded);
    this.changed(ownerId, result);
  }
  tick(now = Date.now()): Promise<void> {
    if (this.work) return this.work;
    this.work = this.reconcile(now).finally(() => {
      this.work = undefined;
      for (const id of new Set([
        ...this.audience(),
        ...this.store.snapshot().devices.map((device) => device.ownerId),
        ...this.published.keys(),
      ]))
        this.notify(id);
    });
    return this.work;
  }
  private eligible(device: StoredPushDevice, sourceId: string): PRPushAttention | undefined {
    const current = this.store.snapshot().devices.find((item) => item.id === device.id);
    if (
      !current?.enabled ||
      current.revision !== device.revision ||
      !this.authorized(device.ownerId)
    )
      return undefined;
    return this.attention(device.ownerId).find(
      (item) => item.id === sourceId && item.current && !item.acknowledgedAt,
    );
  }
  private async reconcile(now: number): Promise<void> {
    for (const device of this.store.snapshot().devices) {
      if (!device.enabled || !this.authorized(device.ownerId)) continue;
      for (const attention of this.attention(device.ownerId)) {
        const existing = this.store
          .snapshot()
          .deliveries.find(
            (delivery) => delivery.deviceId === device.id && delivery.sourceId === attention.id,
          );
        if (
          attention.current &&
          !attention.acknowledgedAt &&
          (!existing || (existing.state === 'cancelled' && !existing.ticketId))
        ) {
          await this.store.reserve(device, attention.id, now);
        }
      }
    }

    let requests = 0;
    const pending = this.store
      .snapshot()
      .deliveries.filter((delivery) =>
        ['queued', 'retry', 'sending', 'ticket'].includes(delivery.state),
      )
      .sort((left, right) => {
        const leftAt = Date.parse(left.nextAttemptAt ?? left.createdAt);
        const rightAt = Date.parse(right.nextAttemptAt ?? right.createdAt);
        return leftAt - rightAt || left.id.localeCompare(right.id);
      });
    for (const delivery of pending) {
      if (delivery.state === 'sending') {
        await this.store.update(delivery.id, {
          state: 'unknown',
          error:
            'Gateway restarted before Expo acceptance was recorded; delivery may have occurred',
        });
        continue;
      }
      const device = this.store.snapshot().devices.find((item) => item.id === delivery.deviceId);
      if (!device || !this.eligible(device, delivery.sourceId)) {
        await this.store.update(delivery.id, {
          state: 'cancelled',
          error: 'Notification is no longer eligible for this recipient',
        });
        continue;
      }
      if (delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > now) continue;
      if (requests++ >= 25) break;
      if (delivery.state === 'ticket') {
        const result = await this.provider.receipt(delivery.ticketId!);
        if (
          result.status === 'pending' ||
          (result.status === 'error' && result.receiptLookup === true)
        ) {
          const expired = now - Date.parse(delivery.createdAt) > 24 * 60 * 60_000;
          await this.store.update(delivery.id, {
            state: expired ? 'unknown' : 'ticket',
            nextAttemptAt: new Date(now + 60_000).toISOString(),
            error: expired
              ? 'Expo receipt unavailable after 24 hours'
              : result.status === 'error'
                ? result.message
                : undefined,
          });
        } else await this.applyResult(delivery, result, now);
        continue;
      }
      const attempt = {
        ...delivery,
        attempts: delivery.attempts + 1,
        deviceRevision: device.revision,
        deviceTokenRevision: device.tokenRevision ?? device.revision,
      };
      await this.store.update(delivery.id, {
        state: 'sending',
        attempts: attempt.attempts,
        deviceRevision: device.revision,
        deviceTokenRevision: attempt.deviceTokenRevision,
        error: undefined,
      });
      // Registration, acknowledgement or audience may have changed during the durable write.
      const attention = this.eligible(device, delivery.sourceId);
      if (!attention) {
        await this.store.update(delivery.id, { state: 'cancelled', attempts: delivery.attempts });
        continue;
      }
      await this.applyResult(
        attempt,
        await this.provider.send(device, attention, delivery.id),
        now,
      );
    }
  }
  private async applyResult(
    delivery: PRPushDelivery,
    result: PushResult,
    now: number,
  ): Promise<void> {
    if (result.status === 'ticket') {
      await this.store.update(delivery.id, {
        state: 'ticket',
        ticketId: result.id,
        nextAttemptAt: new Date(now + 60_000).toISOString(),
      });
    } else if (result.status === 'delivered') {
      await this.store.update(delivery.id, {
        state: 'delivered',
        error: undefined,
        nextAttemptAt: undefined,
      });
    } else if (result.status === 'error') {
      await this.store.recordFailure(
        delivery.id,
        delivery.deviceTokenRevision ?? delivery.deviceRevision,
        {
          state: result.uncertain
            ? 'unknown'
            : result.retryable && delivery.attempts < 5
              ? 'retry'
              : 'failed',
          error: result.message,
          nextAttemptAt: result.retryable
            ? new Date(
                now + Math.min(60_000 * 2 ** Math.max(0, delivery.attempts - 1), 30 * 60_000),
              ).toISOString()
            : undefined,
        },
        result.invalidDevice === true,
      );
    } else throw new Error('Unexpected pending result from Expo send');
  }
}
