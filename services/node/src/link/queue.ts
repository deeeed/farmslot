import { NODE_LINK_LIMITS, NodeLinkFailure } from '@farmslot/protocol';

export type NodeLinkPriority = 'control' | 'interactive' | 'bulk';
interface QueueItem {
  bytes: number;
  priority: NodeLinkPriority;
  expiresAt: number;
  run(): Promise<void>;
  reject(error: unknown): void;
  key?: string;
  cancel?(): Promise<void>;
}

/** Bound pending work and reserve executor capacity for control/interactive operations. */
export class NodeLinkQueue {
  private pending: QueueItem[] = [];
  private active = 0;
  private bulk = 0;
  private bytes = 0;
  private bulkBytes = 0;
  private closed = false;

  constructor(
    private readonly limits: {
      inFlight: number;
      reservedControl: number;
      queuedBytes: number;
    } = NODE_LINK_LIMITS,
    private readonly clock: () => number = Date.now,
  ) {}

  get queuedBytes(): number {
    return this.bytes;
  }
  get activeCount(): number {
    return this.active;
  }

  run<T>(
    priority: NodeLinkPriority,
    bytes: number,
    expiresAt: number,
    operation: () => Promise<T>,
    cancellation?: { key: string; result(): Promise<T> },
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new NodeLinkFailure('STALE_SOCKET', 'Link queue is retired.'));
    const bulkCeiling =
      (this.limits.queuedBytes * (this.limits.inFlight - this.limits.reservedControl)) /
      this.limits.inFlight;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.bytes + bytes > this.limits.queuedBytes ||
      (priority === 'bulk' && this.bulkBytes + bytes > bulkCeiling)
    )
      return Promise.reject(
        new NodeLinkFailure('BACKPRESSURE', 'Link queue byte limit reached.', { admitted: false }),
      );
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        bytes,
        priority,
        expiresAt,
        reject,
        run: async () => {
          const outcome = await Promise.resolve()
            .then(operation)
            .then(
              (value) => ({ ok: true, value }) as const,
              (error: unknown) => ({ ok: false, error }) as const,
            );
          this.release(item);
          if (outcome.ok) resolve(outcome.value);
          else reject(outcome.error);
        },
      };
      if (cancellation) {
        item.key = cancellation.key;
        item.cancel = async () => {
          const outcome = await cancellation.result().then(
            (value) => ({ ok: true, value }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );
          if (outcome.ok) resolve(outcome.value);
          else reject(outcome.error);
        };
      }
      this.pending.push(item);
      this.bytes += bytes;
      if (priority === 'bulk') this.bulkBytes += bytes;
      this.drain();
    });
  }

  async cancel(key: string): Promise<boolean> {
    const index = this.pending.findIndex((item) => item.key === key);
    if (index < 0) return false;
    const [item] = this.pending.splice(index, 1);
    this.bytes -= item.bytes;
    if (item.priority === 'bulk') this.bulkBytes -= item.bytes;
    if (!item.cancel) throw new Error('Queue cancellation has no durable outcome callback');
    await item.cancel();
    return true;
  }

  retire(): void {
    this.closed = true;
    const pending = this.pending;
    this.pending = [];
    this.bytes = 0;
    this.bulkBytes = 0;
    for (const item of pending)
      item.reject(
        new NodeLinkFailure('STALE_SOCKET', 'Queued command was not admitted before retirement.'),
      );
  }

  private drain(): void {
    while (!this.closed && this.active < this.limits.inFlight) {
      const selected = this.pending.findIndex((item) => item.priority === 'control');
      const interactive = this.pending.findIndex((item) => item.priority === 'interactive');
      const index =
        selected >= 0
          ? selected
          : interactive >= 0
            ? interactive
            : this.bulk < this.limits.inFlight - this.limits.reservedControl
              ? 0
              : -1;
      if (index < 0 || this.pending.length === 0) return;
      const [item] = this.pending.splice(index, 1);
      this.bytes -= item.bytes;
      if (item.priority === 'bulk') this.bulkBytes -= item.bytes;
      if (item.expiresAt <= this.clock()) {
        item.reject(
          new NodeLinkFailure('COMMAND_EXPIRED', 'Queued command expired before admission.', {
            admitted: false,
          }),
        );
        continue;
      }
      this.active++;
      if (item.priority === 'bulk') this.bulk++;
      // The item delivers either outcome and releases its own executor capacity.
      void Promise.resolve().then(item.run);
    }
  }

  private release(item: QueueItem): void {
    this.active--;
    if (item.priority === 'bulk') this.bulk--;
    this.drain();
  }
}
