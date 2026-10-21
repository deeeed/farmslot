import { Methods } from '../rpc/registry.js';

import { canonicalResourceJson, type ResourceKey } from './keys.js';

export interface ResourceQueryRetention {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface ResourceQueryDefinition {
  persisted: boolean;
  maxBytes: number;
  /** Shared bound across this method's canonical query entries. */
  retention?: ResourceQueryRetention;
  /** Preserve a migrated read's existing transport timeout when it differs from the default. */
  timeoutMs?: number;
  /** Becomes true only when the slice's writers and read stamps are implemented. */
  live: boolean;
  dependencies(params: unknown): ResourceKey[];
}

const mb = 1024 * 1024;
function requiredId(params: unknown, field: string): string {
  const value = params && typeof params === 'object' ? Reflect.get(params, field) : undefined;
  if (typeof value !== 'string' || !value) throw new Error(`Resource query requires ${field}`);
  return value;
}

/** Closed to runtime registration. Each migration changes its owning definition here. */
export const RESOURCE_QUERY_DEFINITIONS = {
  [Methods.SOURCES_STATUS]: {
    persisted: true,
    maxBytes: 2 * mb,
    timeoutMs: 120_000,
    live: true,
    dependencies: () => [{ family: 'sources', scope: 'farm' }],
  },
  [Methods.RUN_LIST]: {
    persisted: true,
    maxBytes: 20 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 20 * mb },
    live: true,
    dependencies: () => [{ family: 'runs', scope: 'farm' }],
  },
  [Methods.RUN_GET]: {
    persisted: true,
    maxBytes: 20 * mb,
    retention: { maxEntries: 50, maxBytes: 20 * mb },
    live: true,
    dependencies: (params: unknown) => [
      { family: 'run', runId: requiredId(params, 'runId') },
      // Review-round budgets include other runs of the same PR.
      { family: 'runs', scope: 'farm' },
    ],
  },
  [Methods.DECISION_LIST]: {
    persisted: true,
    maxBytes: 10 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 10 * mb },
    live: true,
    dependencies: () => [{ family: 'decisions', scope: 'farm' }],
  },
  [Methods.FAMILY_OBSERVABILITY_GET]: {
    persisted: false,
    maxBytes: 2 * mb,
    live: true,
    dependencies: (params: unknown) => [
      { family: 'family', familyId: requiredId(params, 'familyId') },
      // Retrospectives re-derive consumption from feedback and monitor observations.
      { family: 'decisions', scope: 'farm' },
    ],
  },
  [Methods.RUN_RECIPE_RUNS_FOR_RUN]: {
    persisted: false,
    maxBytes: 2 * mb,
    timeoutMs: 60_000,
    live: true,
    dependencies: (params: unknown) => [
      { family: 'run', runId: requiredId(params, 'runId') },
      { family: 'artifacts', runId: requiredId(params, 'runId') },
    ],
  },
  [Methods.RUN_SLOT_HISTORY]: {
    persisted: false,
    maxBytes: 2 * mb,
    live: true,
    dependencies: () => [
      { family: 'runs', scope: 'farm' },
      { family: 'slots', scope: 'farm' },
    ],
  },
  [Methods.RUN_FOR_SLOT]: {
    persisted: false,
    maxBytes: 20 * mb,
    live: true,
    dependencies: (params: unknown) => [
      { family: 'runs', scope: 'farm' },
      { family: 'slot', slotId: requiredId(params, 'slotId') },
    ],
  },
  [Methods.RUN_RECIPE_RUNS_FOR_SLOT]: {
    persisted: false,
    maxBytes: 2 * mb,
    timeoutMs: 60_000,
    live: true,
    dependencies: (params: unknown) => [
      { family: 'runs', scope: 'farm' },
      { family: 'slot', slotId: requiredId(params, 'slotId') },
    ],
  },
  [Methods.RUN_TAGS_LIST]: {
    persisted: false,
    maxBytes: 2 * mb,
    live: true,
    dependencies: () => [{ family: 'runs', scope: 'farm' }],
  },
  [Methods.FLEET_STATUS]: {
    persisted: false,
    maxBytes: 2 * mb,
    live: false,
    dependencies: () => [{ family: 'slots', scope: 'farm' }],
  },
} satisfies Record<string, ResourceQueryDefinition>;

export type ResourceReadMethod = keyof typeof RESOURCE_QUERY_DEFINITIONS;

export function resourceReadTimeout(method: ResourceReadMethod): number | undefined {
  const definition: ResourceQueryDefinition = RESOURCE_QUERY_DEFINITIONS[method];
  return definition.timeoutMs;
}

declare const queryData: unique symbol;

export interface ResourceQuery<T = unknown> {
  readonly id: string;
  readonly method: ResourceReadMethod;
  readonly params: unknown;
  readonly dependencies: readonly ResourceKey[];
  readonly persisted: boolean;
  readonly maxBytes: number;
  readonly retention?: ResourceQueryRetention;
  readonly live: boolean;
  readonly [queryData]?: T;
}

/** Experimental, portable query factory; mutations and streams are never registered here. */
export function resourceQuery<T = unknown>(
  method: ResourceReadMethod,
  params: unknown = {},
): ResourceQuery<T> {
  const definition: ResourceQueryDefinition = RESOURCE_QUERY_DEFINITIONS[method];
  if (!definition) throw new Error(`Unregistered resource read: ${method}`);
  const canonical = canonicalResourceJson(params ?? {});
  const normalized: unknown = JSON.parse(canonical);
  return {
    id: `${method}:${canonical}`,
    method,
    params: normalized,
    dependencies: definition.dependencies(normalized),
    persisted: definition.persisted,
    maxBytes: definition.maxBytes,
    ...(definition.retention ? { retention: { ...definition.retention } } : {}),
    live: definition.live,
  };
}

/** The server stamps only migrated reads, before entering their existing handlers. */
export function resourceDependenciesForRead(
  method: string,
  params: unknown,
): ResourceKey[] | undefined {
  if (!Object.hasOwn(RESOURCE_QUERY_DEFINITIONS, method)) return undefined;
  const definition: ResourceQueryDefinition =
    RESOURCE_QUERY_DEFINITIONS[method as ResourceReadMethod];
  return definition.live ? definition.dependencies(params) : undefined;
}
