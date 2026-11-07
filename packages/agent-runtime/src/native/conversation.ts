import {
  NATIVE_CONVERSATION_LIMITS,
  type NativeConversationCursor,
  type NativeConversationDeltaPage,
  type NativeConversationOmission,
  type NativeConversationPage,
  type NativeConversationReset,
  type NativeConversationUpdate,
  type NativeSessionEvent,
  type NativeSessionReadResult,
} from '@farmslot/protocol';

const MAX_FRAME = 1024 * 1024;
const MAX_PROJECTION = NATIVE_CONVERSATION_LIMITS.projectionBytes;
const MAX_REPLAY = NATIVE_CONVERSATION_LIMITS.replayEvents;
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** JSON escaping counts too. Iteration never splits a Unicode code point. */
export function splitNativeText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const point of text) {
    const size = encodedBytes(point) - 2;
    if (bytes + size > 60 * 1024 - 2) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += point;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

interface ProjectionEntry {
  event: NativeSessionEvent;
  lastSequence: number;
  bytes: number;
  omission?: NativeConversationOmission;
}

/** Keep request/receipt counts explicit when metadata needs an authorized detail read. */
function boundedMetadata(page: NativeSessionReadResult): NativeConversationPage {
  const base = { ...page, events: [], commands: [], pendingRequests: [] };
  let remaining = 96 * 1024 - encodedBytes(base);
  const take = <T>(items: T[]): T[] => {
    const kept: T[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const bytes = encodedBytes(items[i]);
      if (bytes > remaining) continue;
      kept.unshift(items[i]);
      remaining -= bytes;
    }
    return kept;
  };
  const pendingRequests = take(page.pendingRequests);
  const commands = take(page.commands);
  const inherited =
    'metadataOmitted' in page ? (page as NativeConversationPage).metadataOmitted : undefined;
  const omitted = {
    commands: page.commands.length - commands.length + (inherited?.commands ?? 0),
    pendingRequests:
      page.pendingRequests.length - pendingRequests.length + (inherited?.pendingRequests ?? 0),
  };
  return {
    ...page,
    events: [],
    commands,
    pendingRequests,
    ...(omitted.commands || omitted.pendingRequests ? { metadataOmitted: omitted } : {}),
  };
}

/** The journal writer maintains this projection once, independently of viewer count.
 * Only committed pages enter it. Listeners get a wakeup, never a cumulative transcript.
 */
export class NativeConversationJournal {
  constructor(private readonly hostGeneration: string) {}
  private page?: NativeConversationPage;
  private recent: NativeSessionEvent[] = [];
  private recentBytes = 0;
  private projection: ProjectionEntry[] = [];
  private projectionBytes = 0;
  private historyBefore = 0;
  private readonly listeners = new Set<(page: NativeSessionReadResult) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }
  get sequence(): number {
    return this.page?.cursor ?? 0;
  }
  get metadata(): NativeConversationPage | undefined {
    return this.page;
  }
  get released(): boolean {
    return this.page?.scope?.released === true;
  }

  listen(listener: (page: NativeSessionReadResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(page: NativeSessionReadResult): void {
    if (!this.page && page.events[0] && page.events[0].sequence > (page.scope?.startAfter ?? 0) + 1)
      this.historyBefore = page.events[0].sequence - 1;
    for (const event of page.events) {
      if (event.sequence <= this.sequence) continue;
      this.recent.push(event);
      this.recentBytes += encodedBytes(event);
      while (this.recent.length > MAX_REPLAY || this.recentBytes > MAX_PROJECTION)
        this.recentBytes -= encodedBytes(this.recent.shift()!);
      const last = this.projection.at(-1);
      const sameSegment =
        event.type === 'text.delta' &&
        last?.event.type === 'text.delta' &&
        event.commandId === last.event.commandId &&
        event.generation === last.event.generation;
      if (sameSegment) {
        // Account for only this delta. Stringifying the cumulative prefix on every token
        // makes a long response quadratic even when its transport contains only deltas.
        const added = encodedBytes(event.text ?? '') - 2;
        if (last.omission || last.bytes + added >= MAX_PROJECTION) {
          last.omission ??= {
            anchorSequence: last.event.sequence,
            after: last.lastSequence,
            through: event.sequence,
          };
          last.omission.through = event.sequence;
          last.lastSequence = event.sequence;
        } else {
          last.event = { ...last.event, text: (last.event.text ?? '') + (event.text ?? '') };
          last.lastSequence = event.sequence;
          last.bytes += added;
          this.projectionBytes += added;
        }
      } else {
        const bytes = encodedBytes(event);
        this.projection.push({ event, bytes, lastSequence: event.sequence });
        this.projectionBytes += bytes;
      }
      while (
        (this.projectionBytes > MAX_PROJECTION ||
          this.projection.length > NATIVE_CONVERSATION_LIMITS.projectionRows) &&
        this.projection.length
      ) {
        const removed = this.projection.shift()!;
        this.projectionBytes -= removed.bytes;
        this.historyBefore = removed.lastSequence;
      }
    }
    this.page =
      this.page &&
      page.session === this.page.session &&
      page.commands === this.page.commands &&
      page.pendingRequests === this.page.pendingRequests
        ? { ...this.page, cursor: page.cursor, scope: page.scope }
        : boundedMetadata(page);
    for (const listener of this.listeners) listener({ ...this.page, events: page.events });
  }

  /** Gateway mirrors seed a bounded projection, never fabricate replay for compressed rows. */
  reset(snapshot: NativeConversationReset): void {
    this.page = boundedMetadata(snapshot);
    this.historyBefore = snapshot.historyBefore;
    this.recent = [];
    this.recentBytes = 0;
    this.projection = snapshot.events.map((event, index) => {
      const omission = snapshot.omissions?.find((item) => item.anchorSequence === event.sequence);
      return {
        event,
        bytes: encodedBytes(event),
        lastSequence:
          omission?.through ?? (snapshot.events[index + 1]?.sequence ?? snapshot.cursor + 1) - 1,
        ...(omission ? { omission: { ...omission } } : {}),
      };
    });
    this.projectionBytes = this.projection.reduce((bytes, entry) => bytes + entry.bytes, 0);
  }

  resume(after?: NativeConversationCursor): Exclude<NativeConversationUpdate, { kind: 'delta' }> {
    const page = this.page;
    if (!page) throw new Error('Native conversation has no committed identity');
    const cursor: NativeConversationCursor = {
      executionNodeId: page.session.executionNodeId,
      hostGeneration: this.hostGeneration,
      sessionId: page.session.id,
      generation: page.session.generation,
      sequence: page.cursor,
    };
    const minimum = this.recent[0]?.sequence ?? page.cursor + 1;
    if (
      after &&
      after.executionNodeId === cursor.executionNodeId &&
      after.sessionId === cursor.sessionId &&
      after.hostGeneration === cursor.hostGeneration &&
      after.generation === cursor.generation &&
      Number.isSafeInteger(after.sequence) &&
      after.sequence >= minimum - 1 &&
      after.sequence <= cursor.sequence
    ) {
      const update: NativeConversationUpdate = {
        kind: 'replay',
        cursor,
        page: { ...page, events: this.recent.filter((event) => event.sequence > after.sequence) },
      };
      if (encodedBytes(update) <= MAX_FRAME - 1024) return update;
    }
    const omissions = this.projection.flatMap((entry) =>
      entry.omission ? [{ ...entry.omission }] : [],
    );
    const active = this.projection.at(-1);
    const snapshot: NativeConversationReset = {
      ...page,
      events: this.projection.map((entry) => entry.event),
      historyBefore: this.historyBefore,
      truncated: this.historyBefore > (page.scope?.startAfter ?? 0) || omissions.length > 0,
      ...(omissions.length ? { omissions } : {}),
      ...(active?.event.type === 'text.delta' && active.omission
        ? { activePrefixAfter: active.omission.after }
        : {}),
    };
    // Omitted metadata is explicit; the original authorized read keeps the full detail.
    const update: NativeConversationUpdate = { kind: 'reset', cursor, snapshot };
    if (encodedBytes(update) > MAX_FRAME - 1024)
      return { kind: 'terminal', reason: 'source-unavailable' };
    return update;
  }
}

/** A single bounded delivery queue. start() is called only after the initial reply is written. */
export class NativeConversationSubscription {
  readonly initial: Exclude<NativeConversationUpdate, { kind: 'delta' }>;
  private stopListening: () => void;
  private pending?: NativeConversationPage;
  private delivered?: NativeConversationPage;
  private events: NativeSessionEvent[] = [];
  private bytes = 0;
  private active = false;
  private stopped = false;
  private terminal?: Extract<NativeConversationUpdate, { kind: 'terminal' }>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    journal: NativeConversationJournal,
    after: NativeConversationCursor | undefined,
    private readonly deliver: (update: NativeConversationUpdate) => void,
  ) {
    // Listener first. The journal and this high-water read share the host's synchronous commit order.
    this.stopListening = journal.listen((page) => this.enqueue(page));
    this.initial = journal.resume(after);
    if (this.initial.kind === 'terminal') this.stop();
    else this.delivered = this.initial.kind === 'reset' ? this.initial.snapshot : this.initial.page;
  }

  start(): void {
    if (this.stopped) return;
    this.active = true;
    if (this.terminal) this.finish(this.terminal);
    else if (this.pending) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.stopListening();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.events = [];
  }

  private enqueue(page: NativeConversationPage): void {
    if (this.stopped || this.terminal) return;
    if (
      this.initial.kind !== 'terminal' &&
      page.session.generation !== this.initial.cursor.generation
    ) {
      this.finish({ kind: 'terminal', reason: 'source-unavailable' });
      return;
    }
    this.pending = page;
    this.events.push(...page.events);
    this.bytes += encodedBytes(page.events);
    if (this.bytes + encodedBytes({ ...page, events: [] }) > MAX_FRAME - 1024) {
      this.finish({ kind: 'terminal', reason: 'resync-required' });
      return;
    }
    if (this.active) this.schedule();
  }

  private schedule(): void {
    if (this.bytes >= 64 * 1024) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 50);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const page = this.pending;
    if (!page || this.stopped) return;
    if (this.initial.kind === 'terminal') return;
    const delta: NativeConversationDeltaPage = {
      events: this.events,
      cursor: page.cursor,
      ...(page.session !== this.delivered?.session ? { session: page.session } : {}),
      ...(page.commands !== this.delivered?.commands ? { commands: page.commands } : {}),
      ...(page.pendingRequests !== this.delivered?.pendingRequests
        ? { pendingRequests: page.pendingRequests }
        : {}),
      ...(page.scope ? { scope: page.scope } : {}),
      ...(page.metadataOmitted !== this.delivered?.metadataOmitted
        ? { metadataOmitted: page.metadataOmitted ?? null }
        : {}),
    };
    this.delivered = page;
    const update: NativeConversationUpdate = {
      kind: 'delta',
      cursor: {
        ...this.initial.cursor,
        generation: page.session.generation,
        sequence: page.cursor,
      },
      page: delta,
    };
    this.pending = undefined;
    this.events = [];
    this.bytes = 0;
    if (encodedBytes(update) > MAX_FRAME - 1024)
      this.finish({ kind: 'terminal', reason: 'resync-required' });
    else this.deliver(update);
  }

  private finish(update: Extract<NativeConversationUpdate, { kind: 'terminal' }>): void {
    this.terminal = update;
    this.stopListening();
    if (this.active) {
      this.stop();
      this.deliver(update);
    }
  }
}
