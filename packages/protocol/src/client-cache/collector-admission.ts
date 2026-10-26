import { canonicalResourceJson } from './keys.js';
import {
  type ResourceCollectorQuery,
  resourceCollectorQuery,
  type ResourceQuery,
} from './registry.js';
import type { ResourceCacheConnection, ResourceCacheTransport } from './types.js';

function unsupported(message: string): Error {
  return Object.assign(new Error(message), { code: 'RESOURCE_OBSERVATION_UNSUPPORTED' });
}

/** Connection-bound interests only. Collection and its cadence belong to the gateway. */
export class ResourceCollectorAdmission {
  private connection?: ResourceCacheConnection;
  private binding = '';
  private generation = 0;
  private sequence = 0;
  private desired = new Map<string, ResourceCollectorQuery>();
  private admitted = new Set<string>();
  private acknowledged?: string;
  private failure?: unknown;
  private admissionRefused = false;
  private used = false;
  private contactedSocket = false;
  private pending?: { generation: number; controller: AbortController; done: Promise<void> };
  private queued?: Promise<void>;

  constructor(private readonly transport: ResourceCacheTransport) {}

  update(connection: ResourceCacheConnection, queries: readonly ResourceQuery[]): void {
    const binding = canonicalResourceJson({
      id: connection.id,
      scope: connection.scope,
      authority: connection.authority,
      capability: connection.capabilities?.resourceChanges,
      connected: connection.connected,
    });
    if (binding !== this.binding) {
      if (connection.id !== this.connection?.id) {
        this.sequence = 0;
        this.contactedSocket = false;
      }
      this.generation++;
      this.pending?.controller.abort();
      this.pending = undefined;
      this.admitted.clear();
      this.acknowledged = undefined;
      this.failure = undefined;
      this.admissionRefused = false;
      this.binding = binding;
    }
    this.connection = connection;
    const desired = new Map<string, ResourceCollectorQuery>();
    if (connection.connected && connection.foreground !== false)
      for (const query of queries)
        if (query.collector && query.live && this.supported(query)) {
          const descriptor = resourceCollectorQuery(query.method, query.params);
          desired.set(descriptor.id, descriptor);
        }
    const previous = this.signature();
    this.desired = desired;
    for (const id of this.admitted) if (!desired.has(id)) this.admitted.delete(id);
    if (desired.size) this.used = true;
    if (previous !== this.signature() && !this.admissionRefused) this.failure = undefined;
    this.schedule();
  }

  private signature(): string {
    return canonicalResourceJson([...this.desired.keys()].sort());
  }

  private supported(query?: ResourceQuery): boolean {
    const capability = this.connection?.capabilities?.resourceChanges?.upstreamObservers;
    return (
      capability?.version === 1 &&
      !!this.transport.replaceObservers &&
      (!query || capability.methods.includes(query.method as ResourceCollectorQuery['method']))
    );
  }

  has(query: ResourceQuery): boolean {
    return this.supported(query) && this.desired.has(query.id) && this.admitted.has(query.id);
  }

  async require(query: ResourceQuery, retry: boolean): Promise<void> {
    if (!this.supported(query))
      throw unsupported('This gateway cannot observe this upstream query.');
    if (!this.desired.has(query.id))
      throw unsupported('Observe the upstream query before reading it.');
    if (retry) {
      this.failure = undefined;
      this.admissionRefused = false;
    }
    if (this.has(query)) return;
    await this.flush();
    if (this.failure) throw this.failure;
    if (!this.has(query)) throw unsupported('Upstream observer admission changed before the read.');
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = Promise.resolve().then(async () => {
      this.queued = undefined;
      await this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (
      !this.used ||
      !this.connection?.connected ||
      !this.supported() ||
      this.failure ||
      this.admissionRefused
    )
      return;
    if (this.pending) {
      await this.pending.done;
      if (!this.failure && this.acknowledged !== this.signature()) await this.flush();
      return;
    }
    if (this.acknowledged === this.signature()) return;
    // A new socket has no memberships to withdraw while storage/auth is still opening.
    if (!this.desired.size && !this.contactedSocket) return;
    const generation = this.generation;
    const signature = this.signature();
    const queries = [...this.desired.values()].sort((a, b) => a.id.localeCompare(b.id));
    const sequence = ++this.sequence;
    const controller = new AbortController();
    const pending = { generation, controller, done: Promise.resolve() };
    this.contactedSocket = true;
    this.pending = pending;
    pending.done = (async () => {
      try {
        const response = await this.transport.replaceObservers!(
          {
            version: 1,
            sequence,
            queries: queries.map(({ method, params }) => ({ method, params })),
          },
          controller.signal,
        );
        if (generation !== this.generation || controller.signal.aborted) return;
        if (response.version !== 1 || response.sequence !== sequence || !response.applied)
          throw unsupported('The gateway did not acknowledge the current observer set.');
        this.acknowledged = signature;
        this.admitted = new Set(
          queries.filter((query) => this.desired.has(query.id)).map((query) => query.id),
        );
      } catch (error) {
        if (generation !== this.generation || controller.signal.aborted) return;
        const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
        this.admissionRefused = [
          'METHOD_NOT_FOUND',
          'UNKNOWN_METHOD',
          'AUTH_REQUIRED',
          'AUTH_FORBIDDEN',
        ].includes(String(code));
        this.failure =
          code === 'METHOD_NOT_FOUND' || code === 'UNKNOWN_METHOD'
            ? unsupported('The gateway advertised upstream observers but has no admission method.')
            : error;
        this.admitted.clear();
      } finally {
        if (this.pending === pending) this.pending = undefined;
      }
    })();
    await pending.done;
    // A first/last observer change while the acknowledgement was pending is one replacement.
    if (generation === this.generation && !this.failure && this.acknowledged !== this.signature())
      await this.flush();
  }

  async close(): Promise<void> {
    if (!this.connection) return;
    if (this.admissionRefused && this.acknowledged === undefined) {
      // The gateway refused this owner's admission, so it has no current membership to withdraw.
      this.generation++;
      this.pending?.controller.abort();
      this.connection = undefined;
      this.desired.clear();
      return;
    }
    this.update(this.connection, []);
    await this.flush();
    this.generation++;
    this.pending?.controller.abort();
    if (this.failure) throw this.failure;
  }
}
