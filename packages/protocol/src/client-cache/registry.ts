import { Methods } from '../rpc/registry.js';

import { canonicalResourceJson, type ResourceKey } from './keys.js';
import { nativeHistoryParams, nativeObservationDependencies } from './native-history.js';

export interface ResourceQueryRetention {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly cohort?: string;
  readonly groups?: readonly string[];
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
  /** Requires the experimental server observed-read dispatch contract. */
  requiresObservedRead?: boolean;
  requiresWorkspaceRead?: boolean;
  /** Observation parameters can exclude imperative variants of an existing read method. */
  normalizeParams?(params: unknown): unknown;
  retentionGroups?(params: unknown): string[];
  dependencies(params: unknown, nativeReaderId?: string): ResourceKey[];
}

const mb = 1024 * 1024;
function requiredId(params: unknown, field: string): string {
  const value = params && typeof params === 'object' ? Reflect.get(params, field) : undefined;
  if (typeof value !== 'string' || !value) throw new Error(`Resource query requires ${field}`);
  return value;
}

function planningObservationParams(params: unknown): Record<string, unknown> {
  if (params == null) return {};
  if (typeof params !== 'object' || Array.isArray(params))
    throw new Error('Planning observations require an object');
  const { forceRefresh, ...observation } = params as Record<string, unknown>;
  if (forceRefresh !== undefined && forceRefresh !== false)
    throw new Error('Planning observations cannot forceRefresh');
  return observation;
}

function roadmapListObservationParams(params: unknown): Record<string, unknown> {
  const observation = planningObservationParams(params);
  if (observation.search !== undefined && observation.search !== '')
    throw new Error('Roadmap searches are not persisted observations');
  delete observation.search;
  return observation;
}

function workerInventoryParams(params: unknown): Record<string, unknown> {
  if (params == null) return { includeDisconnected: true };
  if (typeof params !== 'object' || Array.isArray(params))
    throw new Error('Worker inventory observations require an object');
  const source = params as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !['machine', 'machines', 'includeDisconnected'].includes(key))
  )
    throw new Error('Worker inventory observations accept only machine filters');
  if (source.includeDisconnected !== undefined && typeof source.includeDisconnected !== 'boolean')
    throw new Error('includeDisconnected must be a boolean');
  if (
    source.machine !== undefined &&
    (typeof source.machine !== 'string' || !source.machine.trim())
  )
    throw new Error('machine must be a nonempty string');
  if (
    source.machines !== undefined &&
    (!Array.isArray(source.machines) ||
      source.machines.some((machine) => typeof machine !== 'string' || !machine.trim()))
  )
    throw new Error('machines must contain nonempty strings');
  const machines = [
    ...new Set([
      ...(source.machine === undefined ? [] : [source.machine as string]),
      ...((source.machines ?? []) as string[]),
    ]),
  ].sort();
  return {
    includeDisconnected: source.includeDisconnected ?? true,
    ...(machines.length ? { machines } : {}),
  };
}

function workspaceParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new Error('Workspace query requires parameters');
  const value = params as Record<string, unknown>;
  const allowed = [
    'slotId',
    'runId',
    'path',
    'depth',
    'includeIgnored',
    'base',
    'head',
    'target',
    'oldPath',
    'ref',
    'sessionId',
    'executionNodeId',
    'worker',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Workspace observations do not accept commands or owner keys');
  if (value.slotId) {
    requiredId(value, 'slotId');
    if (
      value.sessionId !== undefined ||
      value.executionNodeId !== undefined ||
      value.worker !== undefined
    )
      throw new Error('Slot workspace cannot carry native selectors');
    if (value.runId !== undefined) requiredId(value, 'runId');
  } else {
    requiredId(value, 'sessionId');
    if (value.runId !== undefined)
      throw new Error('Native run identity belongs in its exact worker pin');
    if (value.executionNodeId !== undefined) requiredId(value, 'executionNodeId');
    if (value.executionNodeId === '*') throw new Error('Native workspace requires an exact node');
    if (value.worker !== undefined) {
      const worker = value.worker;
      const fields = ['runId', 'contextId', 'generation', 'leaseId'];
      if (
        !worker ||
        typeof worker !== 'object' ||
        Array.isArray(worker) ||
        Object.keys(worker).some((key) => !fields.includes(key))
      )
        throw new Error('Invalid pinned workspace worker');
      for (const field of fields) requiredId(worker, field);
    }
  }
  if (
    value.path !== undefined &&
    (typeof value.path !== 'string' ||
      value.path.startsWith('/') ||
      value.path.replace(/\\/g, '/').split('/').includes('..'))
  )
    throw new Error('Workspace path must stay relative');
  return {
    ...value,
    ...(value.sessionId ? { executionNodeId: value.executionNodeId ?? 'local' } : {}),
  };
}
function workspaceDependencies(params: unknown, nativeReaderId?: string): ResourceKey[] {
  const value = workspaceParams(params);
  if (value.slotId)
    return [
      {
        family: 'workspace',
        slotId: String(value.slotId),
        ...(value.runId ? { runId: String(value.runId) } : {}),
      },
      { family: 'slot', slotId: String(value.slotId) },
      ...(value.runId ? [{ family: 'run' as const, runId: String(value.runId) }] : []),
    ];
  if (!nativeReaderId)
    throw new Error('Native workspace query requires authenticated reader identity');
  return [
    {
      family: 'workspace',
      ownerId: nativeReaderId,
      nodeId: String(value.executionNodeId),
      sessionId: String(value.sessionId),
      ...(value.worker ? { contextId: canonicalResourceJson(value.worker) } : {}),
    },
  ];
}
function workspaceRetentionGroups(params: unknown): string[] {
  const value = workspaceParams(params);
  return value.slotId
    ? [`slot:${value.slotId}`, ...(value.runId ? [`run:${value.runId}`] : [])]
    : [
        `native:${value.executionNodeId}:${value.sessionId}:${canonicalResourceJson(value.worker ?? null)}`,
      ];
}
const workspaceDefinition: ResourceQueryDefinition = {
  live: true,
  requiresObservedRead: true,
  requiresWorkspaceRead: true,
  persisted: true,
  maxBytes: 1 * mb,
  retention: { maxEntries: 200, maxBytes: 2 * 1024 * mb, cohort: 'workspace' },
  retentionGroups: workspaceRetentionGroups,
  normalizeParams: workspaceParams,
  dependencies: workspaceDependencies,
};

/** Closed to runtime registration. Each migration changes its owning definition here. */
export const RESOURCE_QUERY_DEFINITIONS = {
  [Methods.NATIVE_SESSION_READ]: {
    persisted: true,
    maxBytes: 20 * mb,
    retention: { maxEntries: 10, maxBytes: 20 * mb },
    live: true,
    requiresObservedRead: true,
    normalizeParams: nativeHistoryParams,
    dependencies: (params: unknown, nativeReaderId?: string) =>
      nativeObservationDependencies(Methods.NATIVE_SESSION_READ, params, nativeReaderId ?? ''),
  },
  [Methods.NATIVE_SESSION_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: 1, maxBytes: 2 * mb },
    live: true,
    requiresObservedRead: true,
    dependencies: (params: unknown, nativeReaderId?: string) =>
      nativeObservationDependencies(Methods.NATIVE_SESSION_LIST, params, nativeReaderId ?? ''),
  },
  [Methods.NATIVE_SESSION_CATALOG]: {
    persisted: false,
    maxBytes: 2 * mb,
    retention: { maxEntries: 1, maxBytes: 2 * mb },
    live: true,
    requiresObservedRead: true,
    dependencies: (params: unknown, nativeReaderId?: string) =>
      nativeObservationDependencies(Methods.NATIVE_SESSION_CATALOG, params, nativeReaderId ?? ''),
  },
  [Methods.NATIVE_PROFILE_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: 10, maxBytes: 2 * mb },
    live: true,
    requiresObservedRead: true,
    dependencies: (params: unknown, nativeReaderId?: string) =>
      nativeObservationDependencies(Methods.NATIVE_PROFILE_LIST, params, nativeReaderId ?? ''),
  },
  [Methods.NATIVE_PROFILE_STATUS]: {
    persisted: false,
    maxBytes: 2 * mb,
    retention: { maxEntries: 10, maxBytes: 2 * mb },
    live: true,
    requiresObservedRead: true,
    dependencies: (params: unknown, nativeReaderId?: string) =>
      nativeObservationDependencies(Methods.NATIVE_PROFILE_STATUS, params, nativeReaderId ?? ''),
  },
  [Methods.FS_LIST]: workspaceDefinition,
  [Methods.FS_READ]: workspaceDefinition,
  [Methods.GIT_STATUS]: workspaceDefinition,
  [Methods.GIT_DIFF]: { ...workspaceDefinition, maxBytes: 5 * mb },
  [Methods.GIT_SHOW]: workspaceDefinition,
  [Methods.GIT_BRANCH_DIFF]: workspaceDefinition,
  [Methods.NATIVE_SESSION_WORKSPACE_LIST]: workspaceDefinition,
  [Methods.NATIVE_SESSION_WORKSPACE_READ]: workspaceDefinition,
  [Methods.NATIVE_SESSION_WORKSPACE_CHANGES]: workspaceDefinition,
  [Methods.NATIVE_SESSION_WORKSPACE_DIFF]: { ...workspaceDefinition, maxBytes: 5 * mb },

  [Methods.TMUX_WORKER_LIST]: {
    requiresObservedRead: true,
    persisted: false,
    maxBytes: 2 * mb,
    timeoutMs: 10_000,
    live: true,
    normalizeParams: workerInventoryParams,
    dependencies: (params: unknown) => {
      const machines = (workerInventoryParams(params).machines ?? []) as string[];
      return [
        { family: 'workers', scope: 'farm' },
        ...machines.map((nodeId) => ({ family: 'workers' as const, nodeId })),
      ];
    },
  },
  [Methods.DISPATCH_QUEUE_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: 1, maxBytes: 2 * mb },
    live: true,
    normalizeParams: planningObservationParams,
    dependencies: () => [{ family: 'planning', collection: 'dispatch-queue' }],
  },
  [Methods.WORK_GRAPH_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 2 * mb },
    live: true,
    normalizeParams: planningObservationParams,
    dependencies: () => [{ family: 'planning', collection: 'work-graphs' }],
  },
  [Methods.WORK_GRAPH_GET]: {
    persisted: false,
    maxBytes: 2 * mb,
    live: true,
    normalizeParams: planningObservationParams,
    dependencies: (params: unknown) => [
      {
        family: 'planning',
        collection: 'work-graphs',
        itemId: requiredId(params, 'graphId'),
      },
    ],
  },
  [Methods.BACKLOG_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 2 * mb },
    live: true,
    normalizeParams: planningObservationParams,
    dependencies: () => [{ family: 'planning', collection: 'backlog' }],
  },
  [Methods.ROADMAP_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 2 * mb },
    live: true,
    normalizeParams: roadmapListObservationParams,
    dependencies: () => [
      { family: 'planning', collection: 'roadmap' },
      { family: 'planning', collection: 'backlog' },
      { family: 'runs', scope: 'farm' },
    ],
  },
  [Methods.ROADMAP_GET]: {
    persisted: false,
    maxBytes: 2 * mb,
    live: true,
    normalizeParams: planningObservationParams,
    dependencies: (params: unknown) => [
      { family: 'planning', collection: 'roadmap' },
      { family: 'planning', collection: 'roadmap', itemId: requiredId(params, 'itemId') },
      { family: 'planning', collection: 'backlog' },
      { family: 'planning', collection: 'work-graphs' },
      { family: 'runs', scope: 'farm' },
    ],
  },
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
    requiresObservedRead: true,
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: 1, maxBytes: 2 * mb },
    live: true,
    normalizeParams: (params: unknown) => {
      if (params == null) return {};
      if (
        typeof params !== 'object' ||
        Array.isArray(params) ||
        Object.keys(params).some((key) => key !== 'forceRefresh') ||
        (Reflect.get(params, 'forceRefresh') !== undefined &&
          Reflect.get(params, 'forceRefresh') !== false)
      )
        throw new Error(
          'Fleet observations cannot forceRefresh; use fleet.refresh outside the cache',
        );
      return {};
    },
    dependencies: () => [{ family: 'slots', scope: 'farm' }],
  },
  [Methods.NODES_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: 1, maxBytes: 2 * mb },
    timeoutMs: 10_000,
    live: true,
    dependencies: () => [{ family: 'node', scope: 'farm' }],
  },
  [Methods.RUNTIME_CAPABILITY_LIST]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 2 * mb },
    live: true,
    dependencies: () => [{ family: 'capabilities' }, { family: 'sources', scope: 'farm' }],
  },
  [Methods.RUNTIME_CAPABILITY_STATUS]: {
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 2 * mb },
    live: true,
    dependencies: () => [{ family: 'capabilities' }, { family: 'sources', scope: 'farm' }],
  },
  [Methods.TASK_PROGRESS]: {
    requiresObservedRead: true,
    persisted: true,
    maxBytes: 2 * mb,
    retention: { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: 2 * mb },
    live: true,
    dependencies: (params: unknown) => {
      const runId = params && typeof params === 'object' ? Reflect.get(params, 'runId') : undefined;
      if (typeof runId === 'string' && runId)
        return [
          { family: 'progress', runId },
          { family: 'run', runId },
          { family: 'artifacts', runId },
        ];
      return [{ family: 'slot', slotId: requiredId(params, 'slotId') }];
    },
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
  readonly requiresObservedRead?: boolean;
  readonly requiresWorkspaceRead?: boolean;
  readonly [queryData]?: T;
}

/** Experimental, portable query factory; mutations and streams are never registered here. */
export function resourceQuery<T = unknown>(
  method: ResourceReadMethod,
  params: unknown = {},
  nativeReaderId?: string,
): ResourceQuery<T> {
  const definition: ResourceQueryDefinition = RESOURCE_QUERY_DEFINITIONS[method];
  if (!definition) throw new Error(`Unregistered resource read: ${method}`);
  const canonical = canonicalResourceJson(
    definition.normalizeParams ? definition.normalizeParams(params) : (params ?? {}),
  );
  const normalized: unknown = JSON.parse(canonical);
  return {
    id: `${method}:${canonical}`,
    method,
    params: normalized,
    dependencies: definition.dependencies(normalized, nativeReaderId),
    persisted: definition.persisted,
    maxBytes: definition.maxBytes,
    ...(definition.retention
      ? {
          retention: {
            ...definition.retention,
            ...(definition.retentionGroups
              ? { groups: definition.retentionGroups(normalized) }
              : {}),
          },
        }
      : {}),
    live: definition.live,
    ...(definition.requiresWorkspaceRead ? { requiresWorkspaceRead: true } : {}),
    ...(definition.requiresObservedRead ? { requiresObservedRead: true } : {}),
  };
}

/** The server stamps only migrated reads, before entering their existing handlers. */
export function resourceDependenciesForRead(
  method: string,
  params: unknown,
  nativeReaderId?: string,
): ResourceKey[] | undefined {
  if (!Object.hasOwn(RESOURCE_QUERY_DEFINITIONS, method)) return undefined;
  const definition: ResourceQueryDefinition =
    RESOURCE_QUERY_DEFINITIONS[method as ResourceReadMethod];
  return definition.live ? definition.dependencies(params, nativeReaderId) : undefined;
}
