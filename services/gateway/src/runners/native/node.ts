import { WebSocket } from 'ws';

import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_CLOSE,
  NATIVE_WORKER_COMPACT,
  NATIVE_WORKER_CONFIRM_STOPPED,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_METHODS,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STATE,
  NATIVE_WORKER_STEER,
  NATIVE_WORKER_TRANSFER,
} from '@farmslot/agent-runtime/native';
import {
  NATIVE_HOST_START_TIMEOUT_MS,
  NATIVE_NODE_ADMISSION_TIMEOUT_MS,
  NATIVE_NODE_REQUEST_MARGIN_MS,
} from '@farmslot/agent-runtime/native/host-runtime';
import { NATIVE_HOST_VERSION_SKEW } from '@farmslot/agent-runtime/native/host-unavailable';
import {
  NATIVE_PROFILE_METHODS,
  validateNativeProfileParams,
} from '@farmslot/agent-runtime/native/profile-service';
import { routeNativeSession } from '@farmslot/agent-runtime/native/service';
import { routeNativeWorkerSession } from '@farmslot/agent-runtime/native/worker-service';
import {
  type ExecResult,
  Methods,
  type NativeNodeSessionEnvelope,
  type NativeSessionInfo,
  type NativeSessionListResult,
  type NativeSessionReadResult,
  type NativeSessionRequester,
} from '@farmslot/protocol';
import type { PoolFileEntry } from '@farmslot/protocol/node/slot-by-repo';

import {
  type RawPoolJson,
  readSlotPools,
  resolveMachinePoolEntry,
  SlotConfigError,
  type SlotPools,
} from '../../core/config.js';
import { isLocal } from '../../core/index.js';
import { lazyImport } from '../../core/lazy-import.js';
import { GatewayMethodError } from '../../core/method-error.js';
import { type ConnectedNode, getAllNodes, getNode } from '../../fleet/machine-registry.js';
import {
  assertNodeReconnectCurrent,
  isNodeTransportUnavailableError,
  NodeTransportUnavailableError,
  resolveAfterNodeReconnect,
  sendNodeRequest,
} from '../../fleet/node-rpc.js';
import { withMeasuredNativeProcessCensus } from '../../host-services/native-process.js';
import { readCredentialStoreSnapshot } from '../../security/credential-store.js';
import {
  nativeOwnerAssignedMachines,
  requireGenerationZeroOwner,
} from '../../security/native-node.js';
import { ownsLocalNativeProfile } from '../../security/native-owner.js';
import { MACHINE_RUNNER_PATH_FIELDS, machineRunnerPath } from '../launch-command.js';
import { normalizeRunner, runnerRequiresAccountResolvedModel } from '../registry.js';

import { knownNativeExecutionNodes } from './execution-nodes.js';
import { nodeLaunchRelease } from './host-refresh.js';
import { nativeSessionManager, validateNativeRunner } from './manager.js';

// Both modules route through this one (a cycle).
const loadNativeObservations = lazyImport(() => import('../../resources/native-observations.js'));
const loadNativeWorkspace = lazyImport(() => import('../../methods/native-workspace.js'));
// Loaded once a node refuses a launch as skewed, for the release list.
const loadRunStore = lazyImport(() => import('../../runs/store.js'));

/** Launches a node may refresh its host on another runtime for. */
const NODE_ADMISSION_METHODS: readonly string[] = [
  Methods.NATIVE_SESSION_CREATE,
  Methods.NATIVE_SESSION_ENSURE,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_TRANSFER,
];

/** Requests a node holds while its host refreshes, on top of the launches. */
const NODE_WORK_METHODS: readonly string[] = [
  ...NODE_ADMISSION_METHODS,
  Methods.NATIVE_SESSION_SEND,
  Methods.NATIVE_SESSION_SET_APPROVAL_MODE,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STEER,
];

/**
 * How long the gateway waits for a node's answer. Any request may first wait for a host that is
 * starting, up to the client's start timeout. On a node that refreshes its host, a launch or
 * message may wait for that refresh first: up to 6 idle runners stopped, then a host start.
 */
export function nativeNodeSessionTimeout(method: string, refreshesHost: boolean): number {
  if (method === NATIVE_WORKER_COMPACT) return 185_000;
  return refreshesHost && NODE_WORK_METHODS.includes(method)
    ? NATIVE_NODE_ADMISSION_TIMEOUT_MS
    : NATIVE_HOST_START_TIMEOUT_MS + NATIVE_NODE_REQUEST_MARGIN_MS;
}

type AuthorizedNativeNode = ConnectedNode & {
  nativeSessions: NonNullable<ConnectedNode['nativeSessions']>;
  nativeAuthority: NonNullable<ConnectedNode['nativeAuthority']>;
};

/** A machine's single node principal and its owner, while that assignment stays issued. */
function issuedOfflineNode(machine: string): { owner: string; principalId: string } | undefined {
  const store = readCredentialStoreSnapshot();
  const nodes = store.principals.filter(
    (principal) => principal.subject.type === 'node' && principal.subject.machine === machine,
  );
  const node = nodes.length === 1 ? nodes[0] : undefined;
  const owner = node?.subject.type === 'node' ? node.subject.nativeOwnerPrincipalId : undefined;
  return node &&
    owner &&
    store.principals.some(
      (principal) => principal.id === owner && principal.subject.type !== 'node',
    ) &&
    store.credentials.some(
      (credential) => credential.principalId === node.id && !credential.revokedAt,
    )
    ? { owner, principalId: node.id }
    : undefined;
}

function hasIssuedOfflineAssignment(owner: string, machine: string, principalId?: string): boolean {
  const issued = issuedOfflineNode(machine);
  return issued?.owner === owner && (!principalId || issued.principalId === principalId);
}

/** The owner a machine's node keeps while it is offline, only while that assignment stays issued. */
export function offlineAssignedNativeOwner(machine: string): string | undefined {
  return issuedOfflineNode(machine)?.owner;
}

/** An offline assignment permits waiting only; it never authorizes a request without a live node. */
export function resolveNativeExecutionNode(owner: string, machine: string): AuthorizedNativeNode {
  // The shared remote routing boundary: a replacement at a reused id never owns a node.
  requireGenerationZeroOwner(owner);
  const node = getNode(machine);
  if (!node && hasIssuedOfflineAssignment(owner, machine))
    throw new NodeTransportUnavailableError(
      machine,
      'not-connected',
      'Native execution node is temporarily unavailable',
    );
  if (!node || node.nativeSessions?.ownerPrincipalId !== owner || !node.nativeAuthority)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node is unavailable for this owner',
    );
  if (
    node.ws.readyState !== WebSocket.OPEN &&
    hasIssuedOfflineAssignment(owner, machine, node.nativeAuthority.principalId)
  )
    throw new NodeTransportUnavailableError(
      machine,
      'disconnected',
      'Native execution node connection is unavailable',
    );
  if (!node.nativeAuthority.valid())
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node is unavailable for this owner',
    );
  return node as AuthorizedNativeNode;
}

function assertNativeConnection(
  owner: string,
  machine: string,
  expected: AuthorizedNativeNode,
): void {
  let current: AuthorizedNativeNode;
  try {
    current = resolveNativeExecutionNode(owner, machine);
  } catch (error) {
    if (error instanceof GatewayMethodError)
      throw new GatewayMethodError(
        error.code,
        'Native execution node authority changed while awaiting its response',
      );
    throw error;
  }
  if (current.nativeAuthority.principalId !== expected.nativeAuthority.principalId)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node authority changed while awaiting its response',
    );
  if (current !== expected)
    throw new NodeTransportUnavailableError(
      machine,
      'connection-replaced',
      'Native execution node connection changed while awaiting its response',
    );
}

/** Filesystem helpers use the same native owner and connection checks as worker commands. */
export async function requestNativeNode(
  owner: string,
  machine: string,
  method: string,
  params: unknown,
  timeout: number,
): Promise<unknown> {
  const resolved = resolveAfterNodeReconnect(machine, () =>
    resolveNativeExecutionNode(owner, machine),
  );
  const node = resolved instanceof Promise ? await resolved : resolved;
  assertNodeReconnectCurrent();
  if (!node.nativeSessions.supportsWorkers || !node.nativeSessions.supportsEnsure)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native node does not support owned worker operations',
    );
  let result: unknown;
  try {
    result = await sendNodeRequest(node, method, params, {
      timeout,
      requireSameConnection: true,
    });
  } catch (error) {
    if (isNodeTransportUnavailableError(error)) assertNativeConnection(owner, machine, node);
    throw error;
  }
  assertNativeConnection(owner, machine, node);
  return result;
}

export async function execNativeNodeArgv(
  owner: string,
  machine: string,
  argv: string[],
  timeout: number,
): Promise<ExecResult> {
  return (await requestNativeNode(
    owner,
    machine,
    'exec',
    { argv, timeout },
    timeout + 10_000,
  )) as ExecResult;
}

/**
 * Read the pool directory once into a shared snapshot for trusted executable resolution.
 * Returns an empty snapshot only when the pool directory does not exist yet.
 */
export function loadTrustedNativeExecutableSnapshot(): SlotPools {
  try {
    return readSlotPools();
  } catch (error) {
    if (error instanceof SlotConfigError && error.code === 'POOL_DIR_NOT_FOUND') {
      return [];
    }
    throw error;
  }
}

type ResolvedMachinePoolResult =
  | { readonly ok: true; readonly pool: RawPoolJson }
  | { readonly ok: false; readonly error: unknown };

export interface TrustedNativePoolIndex {
  readonly resolvedByMachine: ReadonlyMap<string, ResolvedMachinePoolResult>;
  readonly localMachines: readonly string[];
}

/**
 * Group a shared pool snapshot by machine once and resolve each machine's canonical pool via
 * `resolveMachinePoolEntry` BEFORE classifying it as local. An auxiliary `host: localhost` entry
 * cannot mark a canonical remote machine as local; an ambiguous machine with any local entry is
 * tracked as local so local resolution fails closed with the ambiguity error instead of falling back.
 */
export function indexTrustedNativePoolSnapshot(pools: SlotPools): TrustedNativePoolIndex {
  const entriesByMachine = new Map<string, PoolFileEntry<RawPoolJson>[]>();
  for (const entry of pools) {
    const machine = entry.pool.machine;
    if (typeof machine !== 'string' || !machine) continue;
    let bucket = entriesByMachine.get(machine);
    if (!bucket) {
      bucket = [];
      entriesByMachine.set(machine, bucket);
    }
    bucket.push(entry);
  }
  const resolvedByMachine = new Map<string, ResolvedMachinePoolResult>();
  const localMachines: string[] = [];
  for (const [machine, entries] of entriesByMachine) {
    try {
      const canonicalPool = resolveMachinePoolEntry(entries, machine)?.pool;
      if (!canonicalPool) continue;
      resolvedByMachine.set(machine, { ok: true, pool: canonicalPool });
      if (isLocal(canonicalPool.host, canonicalPool.machine)) {
        localMachines.push(machine);
      }
    } catch (error) {
      resolvedByMachine.set(machine, { ok: false, error });
      if (entries.some((entry) => isLocal(entry.pool.host, entry.pool.machine))) {
        localMachines.push(machine);
      }
    }
  }
  return {
    resolvedByMachine,
    localMachines,
  };
}

/**
 * Resolve one execution node's trusted runner executable map from an indexed pool snapshot,
 * reusing `resolveMachinePoolEntry` for canonical `<machine>.json` precedence and ambiguous-pool refusal.
 */
export function resolveTrustedNativeExecutablesFromIndex(
  index: TrustedNativePoolIndex,
  executionNodeId: string,
): Record<string, string> | undefined {
  const targetMachines =
    executionNodeId === 'local'
      ? index.localMachines
      : index.resolvedByMachine.has(executionNodeId)
        ? [executionNodeId]
        : [];
  if (targetMachines.length === 0) return undefined;
  const runners = Object.keys(MACHINE_RUNNER_PATH_FIELDS);
  const resolved: Record<string, string> = {};
  for (const machine of targetMachines) {
    const entry = index.resolvedByMachine.get(machine);
    if (!entry) continue;
    if (!entry.ok) throw entry.error;
    for (const runner of runners) {
      if (resolved[runner]) continue;
      const configured = machineRunnerPath(runner, entry.pool);
      if (configured) resolved[runner] = configured;
    }
  }
  return Object.keys(resolved).length ? resolved : undefined;
}

/**
 * Resolve a runner's trusted executable path from the execution node's pool config,
 * matching worker launch and discovery. Never accepts caller-supplied executables.
 */
export async function resolveTrustedNativeExecutable(
  runner: string,
  executionNodeId: string,
  snapshot: SlotPools = loadTrustedNativeExecutableSnapshot(),
): Promise<string | undefined> {
  const normalized = normalizeRunner(runner);
  return resolveTrustedNativeExecutablesFromIndex(
    indexTrustedNativePoolSnapshot(snapshot),
    executionNodeId,
  )?.[normalized];
}

export async function resolveTrustedNativeExecutablesForNode(
  executionNodeId: string,
  snapshot: SlotPools = loadTrustedNativeExecutableSnapshot(),
): Promise<Record<string, string> | undefined> {
  return resolveTrustedNativeExecutablesFromIndex(
    indexTrustedNativePoolSnapshot(snapshot),
    executionNodeId,
  );
}

export async function routeNativeExecution(
  owner: string,
  method: string,
  params: Record<string, unknown>,
  requester?: NativeSessionRequester,
): Promise<unknown> {
  // Resolve the observation owner after the native route module initializes.
  // Its authorization helper also uses this route; eager imports form a cycle.
  const { admitNativeCollectionNode, isNativeObservedRead, nativeObservations } =
    await loadNativeObservations();
  const executionNodeId = params.executionNodeId ?? 'local';
  if (typeof executionNodeId !== 'string' || !executionNodeId.trim())
    throw new GatewayMethodError('INVALID_PARAMS', 'executionNodeId must be a nonempty string');
  if (method === Methods.NATIVE_SESSION_LIST) admitNativeCollectionNode(executionNodeId);
  const worker = NATIVE_WORKER_METHODS.includes(method);
  const needsProfiles = params.profileId !== undefined || NATIVE_PROFILE_METHODS.includes(method);
  if (
    method === NATIVE_WORKER_ENSURE ||
    method === NATIVE_WORKER_RESUME ||
    method === Methods.NATIVE_SESSION_CREATE ||
    method === Methods.NATIVE_SESSION_ENSURE
  ) {
    if (
      typeof params.runner !== 'string' ||
      (params.model !== undefined && typeof params.model !== 'string') ||
      (params.effort !== undefined && typeof params.effort !== 'string')
    )
      throw new GatewayMethodError('INVALID_PARAMS', 'Expected native runner and model strings');
    validateNativeRunner(params.runner, params.model, params.effort);
    // Strict account-catalog runners (Antigravity) validate named-profile models inside
    // that profile's own launch session rather than against the ambient machine catalog.
    // Other runners retain their existing placement/ambient model admission.
    const skipAmbientCatalog =
      params.profileId !== undefined && runnerRequiresAccountResolvedModel(params.runner);
    if (!skipAmbientCatalog) {
      const { nativeModelNodeBlocker } = await loadNativeWorkspace();
      const blocker = await nativeModelNodeBlocker(params.runner, params.model, executionNodeId);
      if (blocker) throw new GatewayMethodError('INVALID_PARAMS', blocker);
    }
  }
  if (executionNodeId === 'local') {
    if (!ownsLocalNativeProfile(owner))
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Native local execution is unavailable for this owner',
      );
    return withMeasuredNativeProcessCensus(() => {
      if (isNativeObservedRead() && method === Methods.NATIVE_PROFILE_STATUS) {
        validateNativeProfileParams(params);
        if (typeof params.profileId !== 'string' || !params.profileId.trim())
          throw new GatewayMethodError('INVALID_PARAMS', 'Native profile ID required');
        return nativeObservations.localProfileStatus(owner, params.profileId);
      }
      return worker
        ? routeNativeWorkerSession(nativeSessionManager, owner, method, params)
        : routeNativeSession(nativeSessionManager, owner, method, params, requester, {
            resolveExecutable: (runner) => resolveTrustedNativeExecutable(runner, 'local'),
          });
    });
  }
  const resolved = resolveAfterNodeReconnect(executionNodeId, () =>
    resolveNativeExecutionNode(owner, executionNodeId),
  );
  const node = resolved instanceof Promise ? await resolved : resolved;
  assertNodeReconnectCurrent();
  if (
    (params.approvalMode !== undefined || method === Methods.NATIVE_SESSION_SET_APPROVAL_MODE) &&
    !node.nativeSessions.supportsApprovalMode
  )
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Execution node upgrade required for per-session approval modes',
    );
  if (
    method === NATIVE_WORKER_CONFIRM_STOPPED &&
    !node.nativeSessions.supportsWorkerStopAttestation
  )
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Execution node upgrade required for explicit stopped-process confirmation; existing sessions remain readable',
    );
  if (needsProfiles && !node.nativeSessions.supportsProfiles)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Execution node upgrade required for native account profiles',
    );
  if (method === Methods.NATIVE_SESSION_ENSURE && !node.nativeSessions.supportsEnsure)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node upgrade required for idempotent creation; existing sessions remain available',
    );
  if (worker && !node.nativeSessions.supportsWorkers)
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native execution node upgrade required for worker launch configuration',
    );
  const remoteExecutable =
    (method === Methods.NATIVE_SESSION_CREATE || method === Methods.NATIVE_SESSION_ENSURE) &&
    typeof params.runner === 'string'
      ? await resolveTrustedNativeExecutable(params.runner, executionNodeId)
      : undefined;
  const observe = isNativeObservedRead();
  const remoteExecutables =
    !observe && method === Methods.NATIVE_PROFILE_STATUS
      ? await resolveTrustedNativeExecutablesForNode(executionNodeId)
      : undefined;
  const send = (hostRelease?: string[]) => {
    const envelope: NativeNodeSessionEnvelope = {
      owner,
      method,
      params,
      ...(requester ? { requester } : {}),
      ...(remoteExecutable ? { executable: remoteExecutable } : {}),
      ...(remoteExecutables ? { executables: remoteExecutables } : {}),
      ...(observe ? { observe: true as const } : {}),
      ...(hostRelease ? { hostRelease } : {}),
    };
    return sendNodeRequest(node, 'native.session', envelope, {
      timeout: nativeNodeSessionTimeout(method, node.nativeSessions.supportsHostRefresh === true),
      requireSameConnection: true,
    });
  };
  let result: unknown;
  try {
    try {
      result = await send();
    } catch (error) {
      // A skew refusal comes before the host gets the launch, so it is sent once more with the
      // sessions the node may stop to refresh that host.
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== NATIVE_HOST_VERSION_SKEW ||
        !node.nativeSessions.supportsHostRefresh ||
        !NODE_ADMISSION_METHODS.includes(method)
      )
        throw error;
      const { getAllRuns } = await loadRunStore();
      // A run cancelled or paused while the first send waited is not launched for.
      assertNodeReconnectCurrent();
      assertNativeConnection(owner, executionNodeId, node);
      // Read with no await before the send, so the node gets the current run census.
      result = await send(nodeLaunchRelease(getAllRuns(), executionNodeId, owner, method, params));
    }
  } catch (error) {
    // A timeout is retryable only while the same issued owner still has authority.
    // Structured node/protocol failures remain terminal regardless of connection state.
    if (isNodeTransportUnavailableError(error))
      assertNativeConnection(owner, executionNodeId, node);
    throw error;
  }
  assertNativeConnection(owner, executionNodeId, node);
  if (observe) result = nativeObservations.unwrapRemote(node.ws, executionNodeId, result);
  if (method === NATIVE_WORKER_STATE) {
    if (
      !result ||
      typeof result !== 'object' ||
      !('stateDirectory' in result) ||
      typeof result.stateDirectory !== 'string' ||
      !result.stateDirectory.startsWith('/')
    )
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Native node returned an invalid worker state directory',
      );
    return result;
  }
  if (method === NATIVE_WORKER_READ) {
    const page = result as NativeSessionReadResult | undefined;
    const scope = page?.scope;
    if (
      !scope ||
      scope.leaseId !== params.leaseId ||
      page?.session?.workerLeaseId !== params.leaseId ||
      !page.session.workerManaged ||
      !Number.isSafeInteger(scope.startAfter) ||
      scope.startAfter < 0 ||
      !Number.isSafeInteger(scope.endAt) ||
      scope.endAt < scope.startAfter ||
      typeof scope.released !== 'boolean' ||
      !Number.isSafeInteger(page.cursor) ||
      page.cursor < scope.startAfter ||
      page.cursor > scope.endAt ||
      !Array.isArray(page.events) ||
      page.events.some(
        (event) =>
          !event ||
          event.sessionId !== params.sessionId ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= scope.startAfter ||
          event.sequence > scope.endAt,
      ) ||
      !Array.isArray(page.commands) ||
      !Array.isArray(page.pendingRequests) ||
      (scope.released && page.pendingRequests.length)
    )
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Native node returned an invalid worker history scope',
      );
  }
  const generationChanged =
    method === NATIVE_WORKER_CANCEL &&
    typeof params.resumeCommandId === 'string' &&
    Boolean(params.resumeCommandId) &&
    typeof params.generation === 'string' &&
    result &&
    typeof result === 'object' &&
    'cancelled' in result &&
    result.cancelled === false &&
    'reason' in result &&
    result.reason === 'generation-changed' &&
    'generation' in result &&
    typeof result.generation === 'string' &&
    Boolean(result.generation) &&
    result.generation !== params.generation &&
    !('session' in result);
  if (
    method === NATIVE_WORKER_CANCEL &&
    (!result ||
      typeof result !== 'object' ||
      !('cancelled' in result) ||
      (result.cancelled !== true && !generationChanged) ||
      !('sessionId' in result) ||
      result.sessionId !== params.sessionId ||
      !('leaseId' in result) ||
      result.leaseId !== params.leaseId ||
      (!generationChanged &&
        params.generation !== undefined &&
        (!('generation' in result) || result.generation !== params.generation)))
  )
    throw new GatewayMethodError(
      'NATIVE_SESSION_ERROR',
      'Native node returned a mismatched worker cancellation',
    );
  const hasSession =
    [
      Methods.NATIVE_SESSION_CREATE,
      Methods.NATIVE_SESSION_ENSURE,
      Methods.NATIVE_SESSION_READ,
      NATIVE_WORKER_READ,
      Methods.NATIVE_SESSION_CLOSE,
      NATIVE_WORKER_ENSURE,
      NATIVE_WORKER_RESUME,
      NATIVE_WORKER_CLOSE,
      NATIVE_WORKER_CONFIRM_STOPPED,
      NATIVE_WORKER_TRANSFER,
    ].some((candidate) => candidate === method) ||
    (method === NATIVE_WORKER_CANCEL &&
      Boolean(result && typeof result === 'object' && 'session' in result));
  if (hasSession || method === Methods.NATIVE_SESSION_LIST) {
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new GatewayMethodError(
        'NATIVE_SESSION_ERROR',
        'Native node returned an invalid session response',
      );
    const sessions = hasSession
      ? 'session' in result
        ? [result.session]
        : undefined
      : 'sessions' in result && Array.isArray(result.sessions)
        ? result.sessions
        : undefined;
    if (!sessions)
      throw new GatewayMethodError('NATIVE_SESSION_ERROR', 'Native node omitted session identity');
    for (const info of sessions) {
      if (
        requester &&
        method === Methods.NATIVE_SESSION_CREATE &&
        !params.resumeSessionId &&
        (!info ||
          typeof info !== 'object' ||
          info.requestedByPrincipalId !== requester.principalId ||
          info.requestedByPrincipalGeneration !== requester.principalGeneration)
      )
        throw new GatewayMethodError(
          'NATIVE_SESSION_ERROR',
          'Native node omitted requester attribution',
        );
      if (
        !info ||
        typeof info !== 'object' ||
        info.executionNodeId !== executionNodeId ||
        info.ownerPrincipalId !== owner ||
        (params.profileId !== undefined && info.profileId !== params.profileId) ||
        (params.profileId !== undefined && info.accountContextId !== params.accountContextId) ||
        typeof info.id !== 'string' ||
        !info.id.trim() ||
        (hasSession && method !== Methods.NATIVE_SESSION_CREATE && info.id !== params.sessionId)
      )
        throw new GatewayMethodError(
          'NATIVE_SESSION_ERROR',
          'Native node returned a mismatched session identity',
        );
    }
  }
  return result;
}

export async function listNativeExecutions(owner: string): Promise<NativeSessionListResult> {
  const assigned = nativeOwnerAssignedMachines(readCredentialStoreSnapshot().principals, owner);
  const nodes = [
    ...new Set([
      ...(ownsLocalNativeProfile(owner) ? ['local'] : []),
      ...assigned,
      ...knownNativeExecutionNodes(owner).filter((machine) => assigned.has(machine)),
      ...getAllNodes()
        .filter((node) => {
          const current = getNode(node.machine);
          return (
            current?.nativeSessions?.ownerPrincipalId === owner && current.nativeAuthority?.valid()
          );
        })
        .map((node) => node.machine),
    ]),
  ];
  const results = await Promise.allSettled(
    nodes.map((executionNodeId) =>
      routeNativeExecution(owner, Methods.NATIVE_SESSION_LIST, { executionNodeId }),
    ),
  );
  const sessions: NativeSessionInfo[] = [];
  const unavailableExecutionNodes: NonNullable<
    NativeSessionListResult['unavailableExecutionNodes']
  > = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled')
      sessions.push(...(result.value as NativeSessionListResult).sessions);
    else {
      if (result.reason instanceof GatewayMethodError && result.reason.code.startsWith('AUTH_'))
        throw result.reason;
      // Partial inventory is explicit: an offline host must not hide sessions on healthy hosts.
      unavailableExecutionNodes.push({
        executionNodeId: nodes[index],
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
  return { sessions, unavailableExecutionNodes };
}
