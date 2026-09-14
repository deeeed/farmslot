import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionInfo,
  NativeSessionReadResult,
} from '@farmslot/protocol';

interface WorkerWindow {
  startAfter: number;
  endAt?: number;
  info: NativeSessionInfo;
  commands?: NativeCommandReceipt[];
}

/** Rebuilt from durable journal ordering, including lease claims made by cancellation. */
export class NativeWorkerHistory {
  private windows = new Map<string, WorkerWindow>();
  private currentLease?: string;
  private sequence = 0;
  private commands = new Map<string, NativeCommandReceipt>();

  assertNewLease(leaseId: string): void {
    if (this.windows.has(leaseId)) throw new Error('Native worker task lease cannot be reused');
  }

  observe(entry: {
    info?: NativeSessionInfo;
    event?: NativeSessionEvent;
    commands?: NativeCommandReceipt[];
  }): void {
    const lease = entry.info?.workerLeaseId;
    if (entry.info && lease !== this.currentLease) {
      const previous = this.currentLease && this.windows.get(this.currentLease);
      if (previous) {
        previous.endAt = this.sequence;
        previous.commands = [...this.commands.values()].map((command) => ({ ...command }));
      }
      if (lease) {
        if (this.windows.has(lease)) throw new Error('Native worker task lease cannot be reused');
        this.windows.set(lease, { startAfter: this.sequence, info: structuredClone(entry.info) });
      }
      this.currentLease = lease;
    }
    if (entry.info && lease) this.windows.get(lease)!.info = structuredClone(entry.info);
    for (const command of entry.commands ?? []) {
      // Journal commands also carry private prompt text. Never retain it in public receipts.
      const { generation, commandId, state, submitted, accepted, outcome } = command;
      this.commands.set(commandId, { generation, commandId, state, submitted, accepted, outcome });
    }
    if (entry.event) this.sequence = entry.event.sequence;
  }

  read(
    leaseId: string,
    allEvents: NativeSessionEvent[],
    pending: NativeSessionEvent[],
    after?: number,
    limit = 200,
  ): NativeSessionReadResult {
    const window = this.windows.get(leaseId);
    if (!window) throw new Error('Native worker history lease is unknown');
    const endAt = window.endAt ?? this.sequence;
    const cursor = after ?? window.startAfter;
    if (!Number.isSafeInteger(cursor) || cursor < window.startAfter || cursor > endAt)
      throw new Error('Invalid native worker history cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid native event limit');
    const scopedEvents = allEvents.slice(window.startAfter, endAt);
    const submitted = new Set(
      scopedEvents
        .filter((event) => event.type === 'command.submitted')
        .map((event) => event.commandId),
    );
    const events: NativeSessionEvent[] = [];
    let bytes = 0;
    for (const event of allEvents.slice(cursor, Math.min(cursor + limit, endAt))) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length && bytes + size > 2 * 1024 * 1024) break;
      events.push(event);
      bytes += size;
    }
    const released = window.endAt !== undefined;
    return {
      session: structuredClone(window.info),
      events,
      cursor: cursor + events.length,
      hasMore: cursor + events.length < endAt,
      commands: (window.commands ?? [...this.commands.values()])
        .filter((command) => submitted.has(command.commandId))
        .slice(-100)
        .map((command) => ({ ...command })),
      pendingRequests: released
        ? []
        : pending.filter((event) => event.sequence > window.startAfter),
      scope: { leaseId, startAfter: window.startAfter, endAt, released },
    };
  }
}
