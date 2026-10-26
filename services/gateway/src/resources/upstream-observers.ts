import type { ResourceObserversReplaceResult } from '@farmslot/protocol';
import {
  type ResourceCollectorQuery,
  resourceCollectorQuery,
} from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';

const MAX_OBSERVER_QUERIES = 128;
const MAX_REPLACEMENT_BYTES = 64 * 1024;

export interface ResourceObserverAuthority {
  isActive(): boolean;
  /** The caller derives its principal and read scope from the live server session. */
  assertRead(query: ResourceCollectorQuery): void;
  /** Lost or unresolvable authority closes this owner's socket, not another observer's. */
  refuse(error: unknown): void;
}

interface ObserverSession {
  latestSequence: number;
  applied: boolean;
  queries: ResourceCollectorQuery[];
  adoptedMethods: Set<ResourceCollectorQuery['method']>;
  authority: ResourceObserverAuthority;
}

export interface PreparedResourceObservers {
  commit(): ResourceObserversReplaceResult;
}

function replacementParams(value: unknown): {
  sequence: number;
  queries: ResourceCollectorQuery[];
} {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['version', 'sequence', 'queries'].includes(key))
  )
    throw new GatewayMethodError('INVALID_PARAMS', 'Provide a resource observer replacement');
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.sequence) ||
    Number(record.sequence) < 1 ||
    !Array.isArray(record.queries) ||
    record.queries.length > MAX_OBSERVER_QUERIES ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REPLACEMENT_BYTES
  )
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      'Resource observer replacement exceeds its contract',
    );
  const queries = new Map<string, ResourceCollectorQuery>();
  for (const descriptor of record.queries) {
    if (
      !descriptor ||
      typeof descriptor !== 'object' ||
      Array.isArray(descriptor) ||
      Object.keys(descriptor).some((key) => !['method', 'params'].includes(key))
    )
      throw new GatewayMethodError(
        'INVALID_PARAMS',
        'Provide registered collector read descriptors',
      );
    let query: ResourceCollectorQuery;
    try {
      query = resourceCollectorQuery(descriptor.method, descriptor.params);
    } catch (error) {
      // The closed registry rejects unsupported methods and imperative parameter variants.
      throw new GatewayMethodError(
        'INVALID_PARAMS',
        error instanceof Error ? error.message : 'Invalid resource collector query',
      );
    }
    queries.set(query.id, query);
  }
  return {
    sequence: Number(record.sequence),
    queries: [...queries.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** One membership set per socket object; no timers, fetchers or client-authored ownership. */
export class GatewayUpstreamObservers {
  private readonly sessions = new Map<object, ObserverSession>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private membershipChanged(): void {
    for (const listener of this.listeners) listener();
  }

  prepareReplacement(
    client: object,
    params: unknown,
    authority: ResourceObserverAuthority,
  ): PreparedResourceObservers {
    const { sequence, queries } = replacementParams(params);
    let session = this.sessions.get(client);
    if (!session) {
      session = {
        latestSequence: 0,
        applied: false,
        queries: [],
        adoptedMethods: new Set(),
        authority,
      };
      this.sessions.set(client, session);
    }
    if (sequence <= session.latestSequence)
      throw new GatewayMethodError(
        'STALE_OBSERVER_REPLACEMENT',
        'Observer sequence already superseded',
      );
    // Reserve before callers can await any future scoped admission work.
    session.latestSequence = sequence;
    const reserved = session;
    let committed = false;
    return {
      commit: () => {
        const current = () =>
          this.sessions.get(client) === reserved && reserved.latestSequence === sequence;
        if (committed || !current() || !authority.isActive())
          return { version: 1, sequence, applied: false };
        for (const query of queries) authority.assertRead(query);
        // Re-entrant checks or delayed callers cannot restore an older add after a removal.
        if (!current() || !authority.isActive()) return { version: 1, sequence, applied: false };
        const changed =
          reserved.queries.length !== queries.length ||
          reserved.queries.some((query, index) => query.id !== queries[index].id);
        committed = true;
        reserved.applied = true;
        reserved.queries = queries;
        for (const query of queries) reserved.adoptedMethods.add(query.method);
        reserved.authority = authority;
        if (changed) this.membershipChanged();
        return { version: 1, sequence, applied: true };
      },
    };
  }

  manages(client: object, method?: ResourceCollectorQuery['method']): boolean {
    const session = this.sessions.get(client);
    return method === undefined
      ? session?.applied === true
      : session?.adoptedMethods.has(method) === true;
  }

  hasInterest(method: ResourceCollectorQuery['method'], params?: unknown): boolean {
    const target = params === undefined ? undefined : resourceCollectorQuery(method, params).id;
    return this.authorizedSessions().some((session) =>
      session.queries.some(
        (query) => query.method === method && (target === undefined || query.id === target),
      ),
    );
  }

  /** Reauthorized, normalized selectors for one collector, deduplicated by query identity. */
  activeQueries(method: ResourceCollectorQuery['method']): ResourceCollectorQuery[] {
    const queries = new Map<string, ResourceCollectorQuery>();
    for (const session of this.authorizedSessions())
      for (const query of session.queries)
        if (query.method === method) queries.set(query.id, query);
    return [...queries.values()];
  }

  private authorizedSessions(): ObserverSession[] {
    const sessions: ObserverSession[] = [];
    for (const [client, session] of this.sessions) {
      if (!session.authority.isActive()) {
        this.sessions.delete(client);
        if (session.queries.length) this.membershipChanged();
        continue;
      }
      try {
        for (const query of session.queries) session.authority.assertRead(query);
      } catch (error) {
        // Revoke interest before closing; another authorized viewer keeps the shared collector alive.
        this.sessions.delete(client);
        if (session.queries.length) this.membershipChanged();
        session.authority.refuse(error);
        continue;
      }
      sessions.push(session);
    }
    return sessions;
  }

  disconnect(client: object): void {
    const previous = this.sessions.get(client);
    this.sessions.delete(client);
    if (previous?.queries.length) this.membershipChanged();
  }
}

export const upstreamObservers = new GatewayUpstreamObservers();
