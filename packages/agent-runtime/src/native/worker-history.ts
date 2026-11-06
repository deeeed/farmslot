import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionInfo,
  NativeSessionReadResult,
} from '@farmslot/protocol';

interface WorkerWindow {
  leaseId: string;
  startAfter: number;
  endAt?: number;
  info: NativeSessionInfo;
  commands?: NativeCommandReceipt[];
  submitted: Set<string>;
}

interface WorkerCommandReceipt extends NativeCommandReceipt {
  leaseId?: string;
}

interface WorkerHistoryEntry {
  info?: NativeSessionInfo;
  event?: NativeSessionEvent;
  commands?: WorkerCommandReceipt[];
}

/** Rebuilt from durable journal ordering, including lease claims made by cancellation. */
export class NativeWorkerHistory {
  private windows = new Map<string, WorkerWindow>();
  private currentWindow?: string;
  private sequence = 0;
  private commands = new Map<string, NativeCommandReceipt>();
  private commandLeases = new Map<string, string | undefined>();

  assertNewLease(leaseId: string): void {
    if ([...this.windows.values()].some((window) => window.leaseId === leaseId))
      throw new Error('Native worker task lease cannot be reused');
  }

  observe(entry: WorkerHistoryEntry): void {
    const lease = entry.info?.workerLeaseId;
    const identity =
      lease && entry.info ? JSON.stringify([lease, entry.info.generation]) : undefined;
    let releasedWindow: WorkerWindow | undefined;
    if (entry.info && identity !== this.currentWindow) {
      const previous = this.currentWindow && this.windows.get(this.currentWindow);
      if (previous) {
        previous.endAt = this.sequence;
        releasedWindow = previous;
      }
      if (lease) {
        if (this.windows.has(identity!))
          throw new Error('Native worker task lease cannot be reused');
        this.windows.set(identity!, {
          leaseId: lease,
          startAfter: this.sequence,
          info: structuredClone(entry.info),
          submitted: new Set(),
        });
      }
      this.currentWindow = identity;
    }
    if (entry.info && identity) this.windows.get(identity)!.info = structuredClone(entry.info);
    for (const command of entry.commands ?? []) {
      // Journal commands also carry private prompt text. Never retain it in public receipts.
      const {
        generation,
        commandId,
        state,
        submitted,
        accepted,
        outcome,
        queued,
        steered,
        structuredResult,
      } = command;
      this.commands.set(commandId, {
        generation,
        commandId,
        state,
        submitted,
        accepted,
        outcome,
        ...(queued ? { queued } : {}),
        ...(steered ? { steered } : {}),
        ...(structuredResult ? { structuredResult: structuredClone(structuredResult) } : {}),
      });
      if (!this.commandLeases.has(commandId))
        this.commandLeases.set(
          commandId,
          command.leaseId ??
            (this.currentWindow ? this.windows.get(this.currentWindow)?.leaseId : undefined),
        );
      const ownerLease = this.commandLeases.get(commandId);
      const frozen = ownerLease
        ? this.windows.get(JSON.stringify([ownerLease, generation]))?.commands
        : undefined;
      const pendingIndex = frozen?.findIndex(
        (receipt) => receipt.commandId === commandId && receipt.queued && !receipt.submitted,
      );
      // Handoff cancellation can settle an unsubmitted queue after its lease window closed.
      if (frozen && pendingIndex !== undefined && pendingIndex >= 0 && state === 'failed')
        frozen[pendingIndex] = { ...this.commands.get(commandId)! };
    }
    // Resume can settle the prior lease's queue in the same entry that claims its successor.
    if (releasedWindow)
      releasedWindow.commands = [...this.commands.values()].map((command) => ({ ...command }));
    if (entry.event) {
      this.sequence = entry.event.sequence;
      if (entry.event.type === 'command.submitted' && entry.event.commandId && this.currentWindow)
        this.windows.get(this.currentWindow)!.submitted.add(entry.event.commandId);
    }
  }

  read(
    leaseId: string,
    allEvents: NativeSessionEvent[],
    pending: NativeSessionEvent[],
    after?: number,
    limit = 200,
    generation?: string,
  ): NativeSessionReadResult {
    const window = generation
      ? this.windows.get(JSON.stringify([leaseId, generation]))
      : [...this.windows.values()].filter((item) => item.leaseId === leaseId).at(-1);
    if (!window) throw new Error('Native worker history lease is unknown');
    const endAt = window.endAt ?? this.sequence;
    const cursor = after ?? window.startAfter;
    if (!Number.isSafeInteger(cursor) || cursor < window.startAfter || cursor > endAt)
      throw new Error('Invalid native worker history cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid native event limit');
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
        .filter(
          (command) =>
            window.submitted.has(command.commandId) ||
            (this.commandLeases.get(command.commandId) === leaseId &&
              command.generation === window.info.generation),
        )
        .slice(-100)
        .map((command) => ({ ...command })),
      pendingRequests: released
        ? []
        : pending.filter((event) => event.sequence > window.startAfter),
      scope: { leaseId, startAfter: window.startAfter, endAt, released },
    };
  }
}
