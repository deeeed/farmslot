import {
  type ConfigProjectsResult,
  type DecisionListResult,
  type FleetStatusResult,
  type GatewayAuthConnectResult,
  mergeRunListObservations,
  Methods,
  RUN_LIST_UNLIMITED,
  type RunListResult,
} from '@farmslot/protocol';
import {
  type GatewayResourceCache,
  type ResourceQuery,
  resourceQuery,
  type ResourceQueryState,
  type ResourceReadMethod,
} from '@farmslot/protocol/client-cache';

/**
 * Recent history stays on demand. A gateway without version lists sends it whole on every read,
 * so there it stays under the existing mobile websocket bound.
 */
export const HISTORY_RUN_LIST_LIMIT = 80;
export const RUN_LIST_ACTIVE_TIMEOUT_MS = 20_000;
/** Also each version-list read and catch-up page: every one is its own request. */
export const RUN_LIST_HISTORY_TIMEOUT_MS = 60_000;
export const nativeActiveRunsQuery = resourceQuery<RunListResult>(Methods.RUN_LIST, {
  active: true,
});
export const nativeRunHistoryQuery = resourceQuery<RunListResult>(Methods.RUN_LIST, {
  limit: HISTORY_RUN_LIST_LIMIT,
  sort: 'newest',
});
/**
 * With version lists, history is a view of the shared row collection: every live run. The open
 * list would page at 500 rows, so it asks for all of them.
 */
export const nativeVersionedRunHistoryQuery = resourceQuery<RunListResult>(Methods.RUN_LIST, {
  sort: 'newest',
  limit: RUN_LIST_UNLIMITED,
});

/**
 * History for a gateway with or without version lists. `null` is a capability not yet known,
 * offline before authentication: both stored variants are read, the whole collection first.
 */
export function nativeRunHistoryQueries(
  versionLists: boolean | null,
): ResourceQuery<RunListResult>[] {
  if (versionLists === null) return [nativeVersionedRunHistoryQuery, nativeRunHistoryQuery];
  return [versionLists ? nativeVersionedRunHistoryQuery : nativeRunHistoryQuery];
}
export const nativeDecisionsQuery = resourceQuery<DecisionListResult>(Methods.DECISION_LIST);
export const nativeFleetQuery = resourceQuery<FleetStatusResult>(Methods.FLEET_STATUS);
/** Farm owners only; it names each project's default branch. */
export const configurationProjectsQuery = resourceQuery<ConfigProjectsResult>(
  Methods.CONFIG_PROJECTS,
);

/**
 * Whether the gateway serves version lists, from the last authentication's capabilities, which
 * outlive a dropped socket. Unknown (`null`) only while disconnected before any authentication.
 */
export function nativeRunListVersionLists(
  capabilities: GatewayAuthConnectResult['capabilities'] | undefined,
  connected: boolean,
): boolean | null {
  if (capabilities) return capabilities.resourceChanges?.versionLists === true;
  return connected ? false : null;
}

export function nativeCollectionReadTimeout(
  method: ResourceReadMethod,
  params: unknown,
): number | undefined {
  if (method === Methods.DECISION_LIST) return 30_000;
  if (method !== Methods.RUN_LIST) return undefined;
  if (!params || typeof params !== 'object') return RUN_LIST_HISTORY_TIMEOUT_MS;
  // A version read and each `ids` page must each finish within the request timeout.
  if (Reflect.get(params, 'versions') === true || Array.isArray(Reflect.get(params, 'ids')))
    return RUN_LIST_HISTORY_TIMEOUT_MS;
  return Reflect.get(params, 'active') === true
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
  private versionLists: boolean | null = false;
  private stops: Array<() => void> = [];
  private historyStops: Array<() => void> = [];
  constructor(private readonly publish: (snapshot: NativeRunCollectionSnapshot) => void) {}

  /** `versionLists` is the gateway's capability, or `null` while it is not yet known. */
  bind(
    cache: GatewayResourceCache | undefined,
    workspaceKey: string | undefined,
    versionLists: boolean | null = false,
  ): void {
    if (cache === this.cache && workspaceKey === this.workspaceKey) {
      if (versionLists === this.versionLists) return;
      this.versionLists = versionLists;
      this.observeHistory();
      this.emit();
      return;
    }
    const sameOwner = workspaceKey !== undefined && workspaceKey === this.workspaceKey;
    this.release();
    if (!sameOwner && this.workspaceKey !== undefined) this.historyRequested = false;
    this.cache = cache;
    this.workspaceKey = workspaceKey;
    this.versionLists = versionLists;
    this.emit();
    if (!cache) return;
    const version = this.version;
    const changed = () => {
      if (this.version === version && this.cache === cache) this.emit();
    };
    this.stops.push(cache.observe(nativeActiveRunsQuery, changed));
    this.stops.push(cache.observe(nativeDecisionsQuery, changed));
    this.stops.push(cache.observe(nativeFleetQuery, changed));
    this.observeHistory();
  }

  async openHistory(): Promise<void> {
    this.historyRequested = true;
    if (!this.cache || this.historyStops.length) return;
    this.observeHistory();
    this.emit();
  }

  /** The row bound of the history this gateway reads, from its query; none when unlimited. */
  historyLimit(): number | null {
    const [shown] = nativeRunHistoryQueries(this.versionLists);
    const limit = (shown.params as { limit?: number }).limit;
    return limit === undefined || limit === RUN_LIST_UNLIMITED ? null : limit;
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

  private observeHistory(): void {
    for (const stop of this.historyStops) stop();
    this.historyStops = [];
    const cache = this.cache;
    if (!cache || !this.historyRequested) return;
    const version = this.version;
    const changed = () => {
      if (version === this.version && this.cache === cache) this.emit();
    };
    for (const query of nativeRunHistoryQueries(this.versionLists))
      this.historyStops.push(cache.observe(query, changed));
  }

  private release(): void {
    this.version++;
    for (const stop of this.stops) stop();
    this.stops = [];
    for (const stop of this.historyStops) stop();
    this.historyStops = [];
  }

  /** With the capability unknown, the stored whole collection when held, else the 80 rows. */
  historyObservation(): ResourceQueryState<RunListResult> | undefined {
    const cache = this.cache;
    if (!cache || !this.historyRequested) return undefined;
    const [shown, fallback] = nativeRunHistoryQueries(this.versionLists).map((query) =>
      cache.read(query),
    );
    return fallback && shown.data === undefined ? fallback : shown;
  }

  private emit(): void {
    const active = this.cache?.read(nativeActiveRunsQuery) ?? { status: 'loading' };
    const history = this.historyObservation();
    this.publish({
      fleet: this.cache?.read(nativeFleetQuery) ?? { status: 'loading' },
      active,
      ...(history ? { history } : {}),
      runs: mergeRunListObservations(active, history),
      decisions: this.cache?.read(nativeDecisionsQuery) ?? { status: 'loading' },
    });
  }
}
