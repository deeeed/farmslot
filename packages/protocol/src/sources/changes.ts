import type { GatewayResourceChangesCapability } from '../rpc/auth.js';
import { Events, type ResourceChangedPayload } from '../transport/events.js';

/** The source revision a controller compares; revisions never compare across epochs. */
export interface SourceRevisionMark {
  epoch: string;
  revision: number;
}

const SOURCE_CHANGE_EVENTS: readonly string[] = [Events.RESOURCE_CHANGED];

/** The one carrier decoder. */
export function sourceResourceChanges(
  event: string,
  payload: unknown,
): ResourceChangedPayload | undefined {
  if (!SOURCE_CHANGE_EVENTS.includes(event)) return undefined;
  const changes = payload;
  if (!changes || typeof changes !== 'object') return undefined;
  const candidate = changes as Partial<ResourceChangedPayload>;
  if (
    candidate.version !== 1 ||
    typeof candidate.epoch !== 'string' ||
    !candidate.epoch ||
    !Array.isArray(candidate.changes)
  )
    return undefined;
  return candidate as ResourceChangedPayload;
}

function sourceMark(payload: ResourceChangedPayload): SourceRevisionMark | undefined {
  const change = payload.changes.find(
    (entry) =>
      entry?.key?.family === 'sources' &&
      entry.key.scope === 'farm' &&
      Number.isSafeInteger(entry.revision) &&
      entry.revision >= 0,
  );
  return change ? { epoch: payload.epoch, revision: change.revision } : undefined;
}

/** True when `next` is a change a reader holding `seen` has not covered. */
export function isNewerSourceRevision(
  next: SourceRevisionMark,
  seen: SourceRevisionMark | undefined,
): boolean {
  return !seen || next.epoch !== seen.epoch || next.revision > seen.revision;
}

export interface SourceChangeFeedState {
  /** Undefined until this connection negotiates notification support. */
  announced?: boolean;
  latest?: SourceRevisionMark;
}

/**
 * One feed per gateway connection, fed with every received event. It remembers
 * whether authentication announced the signal so panels mounted later can tell.
 */
export class SourceChangeFeed {
  private state: SourceChangeFeedState = {};
  private listeners = new Set<() => void>();

  getState = (): SourceChangeFeedState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  receive(event: string, payload: unknown): void {
    const changes = sourceResourceChanges(event, payload);
    const mark = changes ? sourceMark(changes) : undefined;
    const announced = mark ? true : this.state.announced;
    const latest =
      mark && isNewerSourceRevision(mark, this.state.latest) ? mark : this.state.latest;
    if (announced === this.state.announced && latest === this.state.latest) return;
    this.state = { announced, latest };
    for (const listener of this.listeners) listener();
  }

  connected(capability: GatewayResourceChangesCapability | undefined): void {
    const announced = capability?.version === 1;
    const latest = announced
      ? this.state.latest?.epoch === capability.epoch
        ? this.state.latest
        : { epoch: capability.epoch, revision: 0 }
      : undefined;
    this.state = { announced, latest };
    for (const listener of this.listeners) listener();
  }

  /** A new connection must announce again; its revisions start a new comparison. */
  disconnected(): void {
    if (this.state.announced === undefined && !this.state.latest) return;
    this.state = {};
    for (const listener of this.listeners) listener();
  }
}

export function createSourceChangeFeed(): SourceChangeFeed {
  return new SourceChangeFeed();
}

/** The part of a host's gateway client that feeds source changes. */
export interface SourceChangeConnection {
  readonly resourceChanges?: GatewayResourceChangesCapability;
  readonly connectionState?: string;
  subscribe(event: string, handler: (payload: unknown) => void): unknown;
  onConnectionChange(listener: (state: string) => void): unknown;
}

/** Wire a host connection to its feed; hosts call this once per gateway client. */
export function connectSourceChangeFeed(
  feed: SourceChangeFeed,
  connection: SourceChangeConnection,
): void {
  for (const event of SOURCE_CHANGE_EVENTS)
    connection.subscribe(event, (payload) => feed.receive(event, payload));
  connection.onConnectionChange((state) => {
    if (state === 'connected') feed.connected(connection.resourceChanges);
    else feed.disconnected();
  });
  if (connection.connectionState === 'connected') feed.connected(connection.resourceChanges);
}
