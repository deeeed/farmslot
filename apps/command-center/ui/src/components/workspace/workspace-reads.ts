import type { ReactiveController, ReactiveControllerHost } from 'lit';

import { sourceObservationAge } from '@farmslot/protocol';
import {
  resourceQuery,
  type ResourceQueryState,
  type ResourceReadMethod,
} from '@farmslot/protocol/client-cache';

import {
  getResourceCache,
  getResourceNativeOwnerId,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';

interface OpenRead {
  stop?: () => void;
  bind(): void;
  cancel(): void;
  retry(): Promise<unknown>;
  method: string;
  state: ResourceQueryState<unknown>;
}

/** Subscriptions only. The connection's ResourceCache/ResourceStore owns all data and retention. */
export class WorkspaceReads implements ReactiveController {
  private reads = new Map<string, OpenRead>();
  private stopOwner?: () => void;
  private generation = 0;
  private connected = false;
  private ownerKey?: string;
  constructor(
    private host: ReactiveControllerHost,
    private changed: () => void = () => {},
    private runId?: () => string | undefined,
    private retired: () => void = () => {},
  ) {
    host.addController(this);
  }
  hostConnected() {
    this.connected = true;
    this.ownerKey = getResourceWorkspaceKey();
    this.stopOwner = subscribeResourceCache(() => {
      const next = getResourceWorkspaceKey();
      if (next !== this.ownerKey) {
        this.retired();
        this.ownerKey = next;
      }
      for (const read of this.reads.values()) read.bind();
    });
    for (const read of this.reads.values()) read.bind();
  }
  hostDisconnected() {
    this.connected = false;
    this.stopOwner?.();
    this.clear();
  }
  clear() {
    this.generation++;
    for (const read of this.reads.values()) {
      read.stop?.();
      read.cancel();
    }
    this.reads.clear();
  }
  get version(): number {
    return this.generation;
  }
  get hasData(): boolean {
    return [...this.reads.values()].some((read) => read.state.data !== undefined);
  }
  owns(value: unknown): boolean {
    return (
      this.connected &&
      this.ownerKey === getResourceWorkspaceKey() &&
      [...this.reads.values()].some((read) => read.state.data === value)
    );
  }
  get ready() {
    return this.reads.size > 0 && [...this.reads.values()].every((r) => r.state.status === 'ready');
  }
  /**
   * One open read's state, named as `read` names it. Undefined when that read is not open, or the
   * view no longer belongs to the owner that opened it.
   */
  stateOf(method: string, params: unknown): ResourceQueryState<unknown> | undefined {
    if (!this.connected || this.ownerKey !== getResourceWorkspaceKey()) return undefined;
    const pinnedRun = this.runId?.();
    if (pinnedRun && params && typeof params === 'object' && Reflect.get(params, 'slotId'))
      params = { ...params, runId: pinnedRun };
    const query = resourceQuery(method as ResourceReadMethod, params, getResourceNativeOwnerId());
    return this.reads.get(query.id)?.state;
  }
  get error() {
    return [...this.reads.values()].find((r) => r.state.error)?.state.error?.message ?? '';
  }
  get status() {
    const saved = [...this.reads.values()]
      .map((r) => r.state.observedAt)
      .filter((at): at is number => at !== undefined);
    return (
      this.error ||
      (this.ready
        ? ''
        : saved.length
          ? `Saved workspace, ${sourceObservationAge(Math.min(...saved))}. Actions wait for a current read.`
          : 'Waiting for a current workspace source.')
    );
  }
  drop(method: string, params: Record<string, unknown>) {
    const runId = this.runId?.();
    const query = resourceQuery(
      method as ResourceReadMethod,
      { ...params, ...(runId && params.slotId ? { runId } : {}) },
      getResourceNativeOwnerId(),
    );
    const read = this.reads.get(query.id);
    read?.stop?.();
    read?.cancel();
    this.reads.delete(query.id);
  }
  releaseMethods(methods: string[]) {
    for (const [id, read] of this.reads)
      if (methods.includes(read.method)) {
        read.stop?.();
        read.cancel();
        this.reads.delete(id);
      }
  }
  async retry() {
    await Promise.all(
      [...this.reads.values()].filter((read) => read.state.error).map((read) => read.retry()),
    );
  }
  read<T>(method: string, params: unknown, apply: (value: T) => void): Promise<T> {
    const pinnedRun = this.runId?.();
    if (pinnedRun && params && typeof params === 'object' && Reflect.get(params, 'slotId'))
      params = { ...params, runId: pinnedRun };
    let query = resourceQuery<T>(method as ResourceReadMethod, params, getResourceNativeOwnerId());
    const old = this.reads.get(query.id);
    old?.stop?.();
    old?.cancel();
    // Bound active opened snapshots too; durable per-slot/run shared bounds live in ResourceStore.
    if (!old && this.reads.size >= 200) {
      const first = this.reads.keys().next().value!;
      const evicted = this.reads.get(first)!;
      evicted.stop?.();
      evicted.cancel();
      this.reads.delete(first);
    }
    const generation = this.generation;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let bindVersion = 0;
      let applied: T | undefined;
      let appliedOwner: string | undefined;
      const read: OpenRead = {
        state: { status: 'loading' },
        method,
        retry: async () => getResourceCache()?.retry(query),
        cancel: () => {
          if (!settled) {
            settled = true;
            reject(new Error('Workspace read superseded'));
          }
        },
        bind: () => {
          const binding = ++bindVersion;
          read.stop?.();
          const cache = getResourceCache();
          const owner = getResourceWorkspaceKey();
          const reader = getResourceNativeOwnerId();
          if (method.startsWith('native.') && !reader) {
            read.state = {
              status: 'unsupported',
              error: {
                code: 'AUTH_REQUIRED',
                message: 'Native workspace requires its saved authenticated reader.',
              },
            };
            this.changed();
            this.host.requestUpdate();
            return;
          }
          query = resourceQuery<T>(method as ResourceReadMethod, params, reader);
          read.state = { status: 'loading' };
          if (cache && this.connected)
            read.stop = cache.observe(query, (state) => {
              if (
                binding !== bindVersion ||
                generation !== this.generation ||
                owner !== getResourceWorkspaceKey() ||
                this.reads.get(query.id) !== read
              )
                return;
              if (pinnedRun !== this.runId?.()) {
                read.state = { status: 'stale' };
                this.host.requestUpdate();
                return;
              }
              read.state = state;
              if (state.data !== undefined) {
                if (applied !== state.data || appliedOwner !== owner) {
                  applied = state.data;
                  appliedOwner = owner;
                  apply(state.data);
                }
                if (!settled) {
                  settled = true;
                  resolve(state.data);
                }
              }
              if (state.error && !settled) {
                settled = true;
                reject(new Error(state.error.message));
              }
              this.changed();
              this.host.requestUpdate();
            });
          this.changed();
          this.host.requestUpdate();
        },
      };
      this.reads.set(query.id, read);
      read.bind();
    });
  }
}

export function retainOpenedChildren<T extends { path: string; children?: T[] }>(
  previous: T[],
  incoming: T[],
): T[] {
  return incoming.map((entry) => {
    const old = previous.find((row) => row.path === entry.path);
    return !entry.children && old?.children ? { ...entry, children: old.children } : entry;
  });
}
