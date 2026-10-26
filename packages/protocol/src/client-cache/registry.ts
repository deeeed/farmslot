import {
  providerAccountsDependencies,
  providerAccountsObservationParams,
  providerAccountsStoredData,
} from '../contracts/provider-accounts.js';
import type { ConfigGitHubAccountsResult } from '../rpc/config.js';
import type { CheckoutUpdateOperation, GatewayStatusResult } from '../rpc/gateway.js';
import {
  prForSlotObservationParams,
  prForSlotStoredData,
  prReviewCommentsObservationParams,
  prReviewCommentsStoredData,
  prStatusObservationParams,
  prStatusStoredData,
} from '../rpc/pr-observations.js';
import { Methods } from '../rpc/registry.js';
import type { UpstreamObservation } from '../rpc/resource-observers.js';
import {
  runnerModelCatalogObservationParams,
  runnerModelCatalogResourceKey,
  runnerModelCatalogStoredData,
  runnerVisibleModelsObservationParams,
  runnerVisibleModelsStoredData,
} from '../rpc/runner-models.js';

import {
  analyticsParams,
  assessmentDependencies,
  assessmentHistoryParams,
  copilotRuntimeKey,
  domainParams,
  idParams,
  observerEvidenceParams,
  prAutomationDependencies,
  sessionContextParams,
  triageParams,
} from './d07-domains.js';
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
  /** Gateway-owned upstream collection, enabled only after stamped reads are implemented. */
  collector?: 'github' | 'gateway-update' | 'providers';
  /**
   * The reply's upstream source state. `null` marks an explicit answer that is not an upstream
   * observation; `undefined` means the gateway omitted one and the reply is refused.
   */
  sourceObservation?(data: unknown): UpstreamObservation | null | undefined;
  /** Optional durable projection for replies that also carry live-only diagnostics. */
  persistedData?(data: unknown): unknown;
  /** Requires the experimental server observed-read dispatch contract. */
  requiresObservedRead?: boolean;
  requiresWorkspaceRead?: boolean;
  /** Observation parameters can exclude imperative variants of an existing read method. */
  normalizeParams?(params: unknown): unknown;
  retentionGroups?(params: unknown): string[];
  dependencies(params: unknown, nativeReaderId?: string): ResourceKey[];
}

const mb = 1024 * 1024;
export const UPSTREAM_QUERY_MAX_BYTES = 2 * mb;
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

function configurationParams(
  params: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): Record<string, unknown> {
  const input = params ?? {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw new Error('Configuration observations require an object');
  const value = Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined));
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Configuration observations do not accept commands, paths or credentials');
  for (const key of required) requiredId(value, key);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'unfiltered') {
      if (typeof item !== 'boolean') throw new Error('unfiltered must be a boolean');
    } else if (
      typeof item !== 'string' ||
      !item ||
      /[/\\]/.test(item) ||
      item === '.' ||
      item === '..'
    ) {
      throw new Error(`Invalid configuration selector: ${key}`);
    }
  }
  return value;
}

function configurationDependencies(params: unknown): ResourceKey[] {
  const project = params && typeof params === 'object' ? Reflect.get(params, 'project') : undefined;
  // Legacy unmarked reads are stamped too; never admit an unchecked path into a key.
  if (project !== undefined) configurationParams({ project }, ['project'], ['project']);
  return [
    { family: 'configuration', scope: 'farm' },
    ...(typeof project === 'string'
      ? [{ family: 'configuration' as const, scope: 'farm' as const, project }]
      : []),
    // Source-bound project/template packs become readable through their owning source boundary.
    { family: 'sources', scope: 'farm' },
  ];
}

const configurationDefinition: ResourceQueryDefinition = {
  persisted: false,
  maxBytes: 2 * mb,
  live: true,
  requiresObservedRead: true,
  normalizeParams: (params) => configurationParams(params, []),
  dependencies: configurationDependencies,
};

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

const domainDefinition: ResourceQueryDefinition = {
  persisted: false,
  maxBytes: 2 * mb,
  live: true,
  requiresObservedRead: true,
  normalizeParams: (params) => domainParams(params, []),
  dependencies: prAutomationDependencies,
};
const assessmentDefinition: ResourceQueryDefinition = {
  ...domainDefinition,
  dependencies: assessmentDependencies,
};

function prListObservationParams(params: unknown): Record<string, unknown> {
  if (params == null) return {};
  if (typeof params !== 'object' || Array.isArray(params))
    throw new Error('PR list observations require an object');
  const record = params as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['project', 'force'].includes(key)) ||
    (record.force !== undefined && record.force !== false)
  )
    throw new Error('PR list observations cannot force a check or supply unregistered selectors');
  const project = record.project;
  if (project === undefined) return {};
  if (
    typeof project !== 'string' ||
    !project ||
    project.trim() !== project ||
    project.length > 256 ||
    /[/\\]/.test(project) ||
    project === '.' ||
    project === '..'
  )
    throw new Error('PR list observations require a valid project identifier');
  return { project };
}

function upstreamRefreshObservationParams(params: unknown): Record<string, never> {
  if (params == null) return {};
  if (
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => key !== 'refresh') ||
    (Reflect.get(params, 'refresh') !== undefined && Reflect.get(params, 'refresh') !== false)
  )
    throw new Error('Upstream observations cannot force a remote check');
  return {};
}

function githubAccountsStoredData(data: unknown): ConfigGitHubAccountsResult {
  const status = data as ConfigGitHubAccountsResult;
  return {
    accounts: status.accounts.map(({ host, login, active }) => ({ host, login, active })),
    checkedAt: status.checkedAt,
    error: status.error,
    observation: upstreamSourceObservation(status),
  };
}

const STORED_UPDATE_ERROR = 'The gateway could not check its source for updates.';
const STORED_UPDATE_OBSERVATION_ERROR = 'The last gateway update check did not complete.';
const STORED_OPERATION_MESSAGE: Record<CheckoutUpdateOperation['phase'], string> = {
  running: 'Gateway update in progress.',
  complete: 'Gateway update finished.',
  error: 'Gateway update did not complete.',
};

/** Durable update facts only: Git/process diagnostics, paths and PIDs stay in the live reply. */
function gatewayStatusStoredData(data: unknown): GatewayStatusResult {
  const status = data as GatewayStatusResult;
  const { update, observation } = status;
  const operation = update.operation;
  return {
    version: status.version,
    update: {
      ...(update.canUpdate === undefined ? {} : { canUpdate: update.canUpdate }),
      updateAvailable: update.updateAvailable,
      commitsBehind: update.commitsBehind,
      commitsAhead: update.commitsAhead,
      branch: update.branch,
      localSha: update.localSha,
      remoteSha: update.remoteSha,
      lastChecked: update.lastChecked,
      updateCommand: update.updateCommand,
      error: update.error ? STORED_UPDATE_ERROR : null,
      ...(operation
        ? {
            operation: {
              id: operation.id,
              phase: operation.phase,
              message: STORED_OPERATION_MESSAGE[operation.phase],
              updatedAt: operation.updatedAt,
              localSha: operation.localSha,
              targetSha: operation.targetSha,
              ...(operation.desktopRebuildRequired === undefined
                ? {}
                : { desktopRebuildRequired: operation.desktopRebuildRequired }),
              ...(operation.gatewayRestartRequired === undefined
                ? {}
                : { gatewayRestartRequired: operation.gatewayRestartRequired }),
            },
          }
        : {}),
    },
    releaseNotes: status.releaseNotes,
    capabilities: status.capabilities,
    ...(observation
      ? {
          observation: {
            status: observation.status,
            ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
            ...(observation.error
              ? {
                  error: { code: observation.error.code, message: STORED_UPDATE_OBSERVATION_ERROR },
                }
              : {}),
          },
        }
      : {}),
  };
}

/** A local slot answer (no PR lookup applies) is explicit, not a missing upstream observation. */
function prForSlotSourceObservation(data: unknown): UpstreamObservation | null | undefined {
  return data && typeof data === 'object' && Reflect.get(data, 'source') === 'local'
    ? null
    : upstreamSourceObservation(data);
}

/** Only a runner with no catalog source answers without an observation; collected sources never do. */
function runnerModelCatalogSourceObservation(
  data: unknown,
): UpstreamObservation | null | undefined {
  const observation = upstreamSourceObservation(data);
  if (observation !== undefined || !data || typeof data !== 'object') return observation;
  return Reflect.get(data, 'status') === 'unsupported' &&
    Reflect.get(data, 'source') === 'unsupported'
    ? null
    : undefined;
}

/**
 * Legacy reads are stamped too: identity fields are picked so `force` never names another
 * observation, and an identity the observation refuses reads without its upstream key.
 */
function prDetailDependencies(
  method: string,
  identity: () => unknown,
  local: ResourceKey[],
): ResourceKey[] {
  let normalized: unknown;
  try {
    normalized = identity();
  } catch {
    return local;
  }
  return [
    {
      family: 'upstream',
      integration: 'github',
      queryId: `${method}:${canonicalResourceJson(normalized)}`,
    },
    ...local,
  ];
}

function paramField(params: unknown, field: string): unknown {
  return params && typeof params === 'object' ? Reflect.get(params, field) : undefined;
}

const prDetailDefinition = {
  persisted: true,
  maxBytes: UPSTREAM_QUERY_MAX_BYTES,
  retention: {
    maxEntries: Number.MAX_SAFE_INTEGER,
    maxBytes: UPSTREAM_QUERY_MAX_BYTES,
    cohort: 'upstream',
  },
  timeoutMs: 30_000,
  live: true,
  collector: 'github',
  sourceObservation: upstreamSourceObservation,
} as const;

export function upstreamSourceObservation(data: unknown): UpstreamObservation | undefined {
  const observation =
    data && typeof data === 'object' ? Reflect.get(data, 'observation') : undefined;
  if (observation === undefined) return undefined;
  if (
    !observation ||
    typeof observation !== 'object' ||
    !['ready', 'stale', 'error'].includes(observation.status) ||
    (observation.observedAt !== undefined &&
      (!Number.isFinite(observation.observedAt) || observation.observedAt <= 0)) ||
    (observation.status === 'ready' && observation.observedAt === undefined) ||
    (observation.status === 'ready' && observation.error !== undefined) ||
    (observation.error !== undefined &&
      (!observation.error ||
        typeof observation.error.code !== 'string' ||
        typeof observation.error.message !== 'string'))
  )
    throw new Error('The gateway supplied an invalid upstream observation');
  return {
    status: observation.status,
    ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
    ...(observation.error
      ? { error: { code: observation.error.code, message: observation.error.message } }
      : {}),
  };
}

/** Closed to runtime registration. Each migration changes its owning definition here. */
export const RESOURCE_QUERY_DEFINITIONS = {
  [Methods.GATEWAY_STATUS]: {
    persisted: true,
    maxBytes: UPSTREAM_QUERY_MAX_BYTES,
    retention: {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxBytes: UPSTREAM_QUERY_MAX_BYTES,
      cohort: 'upstream',
    },
    timeoutMs: 60_000,
    live: true,
    collector: 'gateway-update',
    sourceObservation: upstreamSourceObservation,
    persistedData: gatewayStatusStoredData,
    normalizeParams: upstreamRefreshObservationParams,
    dependencies: () => [{ family: 'gateway-update', scope: 'gateway' }],
  },
  [Methods.CONFIG_GITHUB_ACCOUNTS]: {
    persisted: true,
    maxBytes: UPSTREAM_QUERY_MAX_BYTES,
    retention: {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxBytes: UPSTREAM_QUERY_MAX_BYTES,
      cohort: 'upstream',
    },
    timeoutMs: 30_000,
    live: true,
    collector: 'github',
    sourceObservation: upstreamSourceObservation,
    persistedData: githubAccountsStoredData,
    normalizeParams: upstreamRefreshObservationParams,
    dependencies: () => [
      {
        family: 'upstream',
        integration: 'github',
        queryId: `${Methods.CONFIG_GITHUB_ACCOUNTS}:{}`,
      },
    ],
  },
  [Methods.PR_LIST]: {
    persisted: true,
    maxBytes: UPSTREAM_QUERY_MAX_BYTES,
    retention: {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxBytes: UPSTREAM_QUERY_MAX_BYTES,
      cohort: 'upstream',
    },
    timeoutMs: 30_000,
    live: true,
    collector: 'github',
    sourceObservation: upstreamSourceObservation,
    normalizeParams: prListObservationParams,
    dependencies: (params: unknown) => {
      const project =
        params && typeof params === 'object' ? Reflect.get(params, 'project') : undefined;
      const normalized = prListObservationParams(project === undefined ? {} : { project });
      return [
        {
          family: 'upstream',
          integration: 'github',
          queryId: `${Methods.PR_LIST}:${canonicalResourceJson(normalized)}`,
        },
        { family: 'runs', scope: 'farm' },
        { family: 'slots', scope: 'farm' },
        { family: 'workers', scope: 'farm' },
        { family: 'configuration', scope: 'farm' },
        { family: 'sources', scope: 'farm' },
      ];
    },
  },
  // PR detail observations; `force` stays an explicit read of the same observation.
  [Methods.PR_STATUS]: {
    ...prDetailDefinition,
    persistedData: prStatusStoredData,
    normalizeParams: prStatusObservationParams,
    dependencies: (params: unknown) =>
      prDetailDependencies(
        Methods.PR_STATUS,
        () =>
          prStatusObservationParams({
            pr: paramField(params, 'pr'),
            project: paramField(params, 'project'),
          }),
        [
          { family: 'runs', scope: 'farm' },
          { family: 'configuration', scope: 'farm' },
          { family: 'sources', scope: 'farm' },
        ],
      ),
  },
  [Methods.PR_FOR_SLOT]: {
    ...prDetailDefinition,
    sourceObservation: prForSlotSourceObservation,
    persistedData: prForSlotStoredData,
    normalizeParams: prForSlotObservationParams,
    dependencies: (params: unknown) =>
      prDetailDependencies(
        Methods.PR_FOR_SLOT,
        () => prForSlotObservationParams({ slotId: paramField(params, 'slotId') }),
        [
          { family: 'slots', scope: 'farm' },
          { family: 'configuration', scope: 'farm' },
          { family: 'sources', scope: 'farm' },
        ],
      ),
  },
  [Methods.PR_REVIEW_COMMENTS]: {
    ...prDetailDefinition,
    persistedData: prReviewCommentsStoredData,
    normalizeParams: prReviewCommentsObservationParams,
    dependencies: (params: unknown) =>
      prDetailDependencies(
        Methods.PR_REVIEW_COMMENTS,
        () =>
          prReviewCommentsObservationParams({
            pr: paramField(params, 'pr'),
            repo: paramField(params, 'repo'),
          }),
        [],
      ),
  },
  [Methods.RUNNER_MODEL_CATALOG]: {
    persisted: true,
    maxBytes: UPSTREAM_QUERY_MAX_BYTES,
    retention: {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxBytes: UPSTREAM_QUERY_MAX_BYTES,
      cohort: 'upstream',
    },
    timeoutMs: 30_000,
    live: true,
    collector: 'providers',
    sourceObservation: runnerModelCatalogSourceObservation,
    persistedData: runnerModelCatalogStoredData,
    normalizeParams: runnerModelCatalogObservationParams,
    dependencies: (params: unknown) => [runnerModelCatalogResourceKey(params)],
  },
  // Per-machine runner seats; forceRefresh stays an imperative read.
  [Methods.PROVIDER_ACCOUNTS_SNAPSHOT]: {
    persisted: true,
    maxBytes: UPSTREAM_QUERY_MAX_BYTES,
    retention: {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxBytes: UPSTREAM_QUERY_MAX_BYTES,
      cohort: 'upstream',
    },
    timeoutMs: 45_000,
    live: true,
    collector: 'providers',
    sourceObservation: upstreamSourceObservation,
    persistedData: providerAccountsStoredData,
    normalizeParams: providerAccountsObservationParams,
    dependencies: providerAccountsDependencies,
  },
  // Principal-scoped preferences share the reader's owner profile key; SET stays imperative.
  [Methods.RUNNER_VISIBLE_MODELS_GET]: {
    persisted: true,
    maxBytes: 1 * mb,
    retention: { maxEntries: 16, maxBytes: 1 * mb },
    live: true,
    requiresObservedRead: true,
    persistedData: runnerVisibleModelsStoredData,
    normalizeParams: runnerVisibleModelsObservationParams,
    dependencies: (_params: unknown, readerId?: string) => {
      if (!readerId) throw new Error('Visible model preferences require the authenticated reader');
      return [{ family: 'profiles', scope: 'owner', ownerId: readerId }];
    },
  },
  // D07 observations. Their imperative siblings are deliberately absent.
  [Methods.PR_WATCH_LIST]: domainDefinition,
  [Methods.PR_WATCH_GET]: {
    ...domainDefinition,
    normalizeParams: (params: unknown) => idParams(params, ['id']),
  },
  [Methods.PR_RULES_LIST]: domainDefinition,
  [Methods.PR_REVIEW_REQUEST_GET]: {
    ...domainDefinition,
    normalizeParams: (params: unknown) => idParams(params, ['id']),
  },
  [Methods.PR_PUSH_LIST]: domainDefinition,
  [Methods.ASSESSMENT_LIST]: {
    ...assessmentDefinition,
    normalizeParams: assessmentHistoryParams,
  },
  [Methods.ASSESSMENT_GET]: {
    ...assessmentDefinition,
    normalizeParams: (params: unknown) => idParams(params, ['id']),
  },
  [Methods.ASSESSMENT_SUMMARY]: assessmentDefinition,
  [Methods.ASSESSMENT_REPORT]: {
    ...assessmentDefinition,
    // The no-id variant creates an artifact and must remain an explicit command.
    normalizeParams: (params: unknown) => idParams(params, ['id']),
  },
  [Methods.ASSESSMENT_STATUS]: {
    ...assessmentDefinition,
    dependencies: () => [...assessmentDependencies(), { family: 'configuration', scope: 'farm' }],
  },
  [Methods.DECISION_ADVICE_GET]: {
    ...assessmentDefinition,
    normalizeParams: (params: unknown) => idParams(params, ['runId', 'decisionId']),
    dependencies: (params: unknown) => [
      ...assessmentDependencies(),
      { family: 'run', runId: String(idParams(params, ['runId', 'decisionId']).runId) },
      { family: 'decisions', scope: 'farm' },
      { family: 'configuration', scope: 'farm' },
    ],
  },
  [Methods.FAILURE_TRIAGE_GET]: {
    ...assessmentDefinition,
    normalizeParams: triageParams,
    dependencies: (params: unknown) => [
      ...assessmentDependencies(),
      { family: 'run', runId: String(triageParams(params).runId) },
      { family: 'artifacts', runId: String(triageParams(params).runId) },
      { family: 'configuration', scope: 'farm' },
    ],
  },
  [Methods.ANALYTICS_QUERY]: {
    ...domainDefinition,
    normalizeParams: analyticsParams,
    // Dimensions/scannedRuns cover the whole corpus even on a project-filtered read.
    dependencies: () => [{ family: 'analytics', scope: 'farm' }],
  },
  [Methods.COPILOT_STATUS]: {
    ...domainDefinition,
    timeoutMs: 10_000,
    dependencies: () => [
      copilotRuntimeKey,
      { family: 'runs', scope: 'farm' },
      { family: 'slots', scope: 'farm' },
      { family: 'workers', scope: 'farm' },
      { family: 'configuration', scope: 'farm' },
      { family: 'sources', scope: 'farm' },
    ],
  },
  [Methods.CHAT_CONTEXT]: {
    ...domainDefinition,
    dependencies: () => [
      copilotRuntimeKey,
      { family: 'runs', scope: 'farm' },
      { family: 'slots', scope: 'farm' },
      { family: 'decisions', scope: 'farm' },
      { family: 'planning', collection: 'dispatch-queue' },
    ],
  },
  [Methods.CHAT_OBSERVER_EVIDENCE]: {
    ...domainDefinition,
    normalizeParams: observerEvidenceParams,
    dependencies: () => [copilotRuntimeKey],
  },
  [Methods.CHAT_SESSION_CONTEXT]: {
    ...domainDefinition,
    normalizeParams: sessionContextParams,
    dependencies: (params: unknown) => [
      copilotRuntimeKey,
      { ...copilotRuntimeKey, sessionId: String(sessionContextParams(params).sessionId) },
    ],
  },
  [Methods.CONFIG_PROJECTS]: {
    ...configurationDefinition,
    persisted: true,
    retention: { maxEntries: 1, maxBytes: 2 * mb },
  },
  [Methods.CONFIG_POOLS]: configurationDefinition,
  [Methods.CONFIG_POOL]: {
    ...configurationDefinition,
    normalizeParams: (params: unknown) => configurationParams(params, ['machine'], ['machine']),
  },
  [Methods.CONFIG_POOL_RAW]: {
    ...configurationDefinition,
    normalizeParams: (params: unknown) => configurationParams(params, ['machine'], ['machine']),
  },
  [Methods.CONFIG_PROJECT]: {
    ...configurationDefinition,
    normalizeParams: (params: unknown) => configurationParams(params, ['project'], ['project']),
  },
  [Methods.CONFIG_TEMPLATES]: {
    ...configurationDefinition,
    normalizeParams: (params: unknown) => configurationParams(params, ['project'], ['project']),
  },
  [Methods.CONFIG_TEMPLATE_OPTIONS]: {
    ...configurationDefinition,
    normalizeParams: (params: unknown) => {
      const value = configurationParams(
        params,
        [
          'project',
          'flowType',
          'platform',
          'runMode',
          'domain',
          'executionTemplateId',
          'unfiltered',
        ],
        ['project'],
      );
      if (value.unfiltered !== true) requiredId(value, 'flowType');
      return value;
    },
  },
  [Methods.CONFIG_TEMPLATE_PREVIEW]: {
    ...configurationDefinition,
    normalizeParams: (params: unknown) =>
      configurationParams(
        params,
        [
          'project',
          'flowType',
          'executionTemplateId',
          'executionTemplateSourceId',
          'executionTemplateSha256',
        ],
        ['project', 'flowType'],
      ),
  },
  [Methods.LLM_CONFIG_GET]: configurationDefinition,
  [Methods.LLM_AUTH_LIST]: configurationDefinition,
  [Methods.LLM_TIERS]: configurationDefinition,
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

export type ResourceCollectorReadMethod = {
  [Method in ResourceReadMethod]: (typeof RESOURCE_QUERY_DEFINITIONS)[Method] extends {
    collector: string;
  }
    ? Method
    : never;
}[ResourceReadMethod];

/** Advertise only collectors whose owning read and notification contract are enabled. */
export function resourceCollectorReadMethods(): ResourceCollectorReadMethod[] {
  return Object.entries(RESOURCE_QUERY_DEFINITIONS)
    .filter(([, definition]) => {
      const query: ResourceQueryDefinition = definition;
      return query.live && query.collector !== undefined;
    })
    .map(([method]) => method as ResourceCollectorReadMethod);
}

export interface ResourceCollectorQuery {
  id: string;
  method: ResourceCollectorReadMethod;
  params: unknown;
}

/** Collector selectors use exactly the same closed normalization as client query identities. */
export function resourceCollectorQuery(
  method: unknown,
  params: unknown = {},
): ResourceCollectorQuery {
  if (typeof method !== 'string' || !Object.hasOwn(RESOURCE_QUERY_DEFINITIONS, method))
    throw new Error('Provide a registered collector read');
  const definition: ResourceQueryDefinition =
    RESOURCE_QUERY_DEFINITIONS[method as ResourceReadMethod];
  if (!definition.collector) throw new Error('Provide a registered collector read');
  const query = resourceQuery(method as ResourceCollectorReadMethod, params);
  return { id: query.id, method: method as ResourceCollectorReadMethod, params: query.params };
}

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
  readonly collector?: 'github' | 'gateway-update' | 'providers';
  readonly sourceObservation?: (data: unknown) => UpstreamObservation | null | undefined;
  readonly persistedData?: (data: unknown) => unknown;
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
    ...(definition.collector ? { collector: definition.collector } : {}),
    ...(definition.sourceObservation ? { sourceObservation: definition.sourceObservation } : {}),
    ...(definition.persistedData ? { persistedData: definition.persistedData } : {}),
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
