import {
  type ConfigProjectsResult,
  type DecisionListResult,
  type FleetStatusResult,
  mergeRunListObservations,
  Methods,
  type RunListResult,
} from '@farmslot/protocol';
import {
  type GatewayResourceCache,
  resourceQuery,
  type ResourceQueryState,
  type ResourceReadMethod,
} from '@farmslot/protocol/client-cache';

/** Recent history stays on demand and under the existing mobile websocket bound. */
export const HISTORY_RUN_LIST_LIMIT = 80;
export const RUN_LIST_ACTIVE_TIMEOUT_MS = 20_000;
export const RUN_LIST_HISTORY_TIMEOUT_MS = 60_000;
export const nativeActiveRunsQuery = resourceQuery<RunListResult>(Methods.RUN_LIST, {
  active: true,
});
export const nativeRunHistoryQuery = resourceQuery<RunListResult>(Methods.RUN_LIST, {
  limit: HISTORY_RUN_LIST_LIMIT,
  sort: 'newest',
});
export const nativeDecisionsQuery = resourceQuery<DecisionListResult>(Methods.DECISION_LIST);
export const nativeFleetQuery = resourceQuery<FleetStatusResult>(Methods.FLEET_STATUS);
/** Farm owners only; it names each project's default branch. */
export const configurationProjectsQuery = resourceQuery<ConfigProjectsResult>(
  Methods.CONFIG_PROJECTS,
);

export function nativeCollectionReadTimeout(
  method: ResourceReadMethod,
  params: unknown,
): number | undefined {
  if (method === Methods.DECISION_LIST) return 30_000;
  if (method !== Methods.RUN_LIST) return undefined;
  return params && typeof params === 'object' && Reflect.get(params, 'active') === true
    ? RUN_LIST_ACTIVE_TIMEOUT_MS
    : RUN_LIST_HISTORY_TIMEOUT_MS;
}

export interface NativeRunCollectionSnapshot {
  fleet: ResourceQueryState<FleetStatusResult>;
  runs: ResourceQueryState<RunListResult>;
  active: ResourceQueryState<RunListResult>;
  history?: ResourceQueryState<RunListResult>;
  decisions: ResourceQueryState<DecisionListResult>;
}

/** The native stores project these observations; payload events never own the collections. */
export class NativeRunCollections {
  private cache?: GatewayResourceCache;
  private workspaceKey?: string;
  private version = 0;
  private historyRequested = false;
  private stops: Array<() => void> = [];
  private stopHistory?: () => void;
  constructor(private readonly publish: (snapshot: NativeRunCollectionSnapshot) => void) {}

  bind(cache: GatewayResourceCache | undefined, workspaceKey: string | undefined): void {
    if (cache === this.cache && workspaceKey === this.workspaceKey) return;
    const sameOwner = workspaceKey !== undefined && workspaceKey === this.workspaceKey;
    this.release();
    if (!sameOwner && this.workspaceKey !== undefined) this.historyRequested = false;
    this.cache = cache;
    this.workspaceKey = workspaceKey;
    this.emit();
    if (!cache) return;
    const version = this.version;
    const changed = () => {
      if (this.version === version && this.cache === cache) this.emit();
    };
    this.stops.push(cache.observe(nativeActiveRunsQuery, changed));
    this.stops.push(cache.observe(nativeDecisionsQuery, changed));
    this.stops.push(cache.observe(nativeFleetQuery, changed));
    if (this.historyRequested) this.stopHistory = cache.observe(nativeRunHistoryQuery, changed);
  }

  async openHistory(): Promise<void> {
    const cache = this.cache;
    this.historyRequested = true;
    if (!cache || this.stopHistory) return;
    const version = this.version;
    this.stopHistory = cache.observe(nativeRunHistoryQuery, () => {
      if (version === this.version && this.cache === cache) this.emit();
    });
    this.emit();
  }

  async retryDecisions(): Promise<void> {
    await this.cache?.retry(nativeDecisionsQuery);
  }

  dispose(): void {
    this.release();
    this.cache = undefined;
    this.workspaceKey = undefined;
    this.historyRequested = false;
    this.emit();
  }

  private release(): void {
    this.version++;
    for (const stop of this.stops) stop();
    this.stops = [];
    this.stopHistory?.();
    this.stopHistory = undefined;
  }

  private emit(): void {
    const active = this.cache?.read(nativeActiveRunsQuery) ?? { status: 'loading' };
    const history =
      this.cache && this.historyRequested ? this.cache.read(nativeRunHistoryQuery) : undefined;
    this.publish({
      fleet: this.cache?.read(nativeFleetQuery) ?? { status: 'loading' },
      active,
      ...(history ? { history } : {}),
      runs: mergeRunListObservations(active, history),
      decisions: this.cache?.read(nativeDecisionsQuery) ?? { status: 'loading' },
    });
  }
}
