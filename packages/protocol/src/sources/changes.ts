import { Events, type ResourceChangedPayload } from '../transport/events.js';

/** The source revision a controller compares; revisions never compare across epochs. */
export interface SourceRevisionMark {
  epoch: string;
  revision: number;
}

/**
 * The one carrier decoder (ADR-069 Amendment 1). Until `resource.changed` exists the
 * payload rides on `hello` and `fleet.updated`; adopting ADR-071 changes only this.
 */
export function sourceResourceChanges(
  event: string,
  payload: unknown,
): ResourceChangedPayload | undefined {
  if (event !== Events.HELLO && event !== Events.FLEET_UPDATED) return undefined;
  const changes = (payload as { resourceChanges?: unknown } | null)?.resourceChanges;
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
  /** Undefined until this connection's `hello` arrives. */
  announced?: boolean;
  latest?: SourceRevisionMark;
}

/**
 * One feed per gateway connection, fed with every received event. It remembers
 * whether `hello` announced the signal so panels mounted later can tell.
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
    if (event !== Events.HELLO && event !== Events.FLEET_UPDATED) return;
    const changes = sourceResourceChanges(event, payload);
    const mark = changes ? sourceMark(changes) : undefined;
    const announced = event === Events.HELLO ? Boolean(mark) : this.state.announced;
    const latest =
      mark && isNewerSourceRevision(mark, this.state.latest) ? mark : this.state.latest;
    if (announced === this.state.announced && latest === this.state.latest) return;
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
