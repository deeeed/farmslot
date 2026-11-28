import {
  isPickerCatalogModel,
  Methods,
  type NativeSessionCatalogResult,
  type NativeSessionExecutionNode,
  type Principal,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { farmslotRoot, isLocal } from '../core/index.js';
import { lazyImport } from '../core/lazy-import.js';
import { readMachinePoolSnapshot } from '../fleet/machine-pool-snapshot.js';
import { getNode } from '../fleet/machine-registry.js';
import { nodeModelCatalogs } from '../runners/model-catalog.js';
import { runnerSupportsReadonlyReviewWorkspace } from '../runners/native/review-workspace.js';
import {
  DEFAULT_COPILOT_RUNNER,
  getRunnerDefinition,
  KNOWN_RUNNERS,
  runnerModelNodeBlocker,
  runnerSupportsNativeTaskReuse,
} from '../runners/registry.js';
import { describeVisibleModels } from '../runners/visible-models.js';
import { readCredentialStoreSnapshot } from '../security/credential-store.js';
import { nativeOwnerAssignedMachines } from '../security/native-node.js';
import { ownsLocalNativeProfile } from '../security/native-owner.js';

import { standaloneCatalogTargets } from './native-catalog-targets.js';

// The native session module imports this one (a cycle), and tests mock the originator module.
const loadNativeSession = lazyImport(() => import('./native-session.js'));
const loadWorkOriginator = lazyImport(() => import('../security/work-originator.js'));

export {
  nativeWorkspaceChanges,
  nativeWorkspaceDiff,
  nativeWorkspaceList,
} from '@farmslot/agent-runtime/native/workspace';

export async function nativeCatalog(
  owner: string,
  allowWorkers = true,
  delegatedReader?: Principal,
): Promise<NativeSessionCatalogResult> {
  const assigned = nativeOwnerAssignedMachines(readCredentialStoreSnapshot().principals, owner);
  let contexts: NativeSessionCatalogResult['contexts'] = [
    ...(ownsLocalNativeProfile(owner)
      ? [{ cwd: farmslotRoot(), label: 'Farmslot checkout', supportsProfiles: true }]
      : []),
  ];
  /** Context node id ('local' or a machine) to the pool machine its node catalog is keyed by. */
  let contextMachines = new Map<string, string>();
  let executionNodes: NativeSessionExecutionNode[] | undefined;
  if (delegatedReader) {
    const targets = await standaloneCatalogTargets(delegatedReader);
    contexts = targets.contexts;
    contextMachines = targets.contextMachines;
    executionNodes = targets.executionNodes;
  } else {
    const snapshot = readMachinePoolSnapshot();
    const ownsLocal = ownsLocalNativeProfile(owner);
    for (const { pool } of snapshot.pools) {
      const resolved = snapshot.resolvedByMachine.get(pool.machine);
      if (!resolved?.ok) continue;
      const machine = resolved.pool;
      for (const slot of Array.isArray(pool.slots) ? pool.slots : []) {
        if (!slot.repo) continue;
        const executionNodeId =
          isLocal(machine.host, machine.machine) && ownsLocal ? 'local' : pool.machine;
        if (executionNodeId === 'local' && !ownsLocal) continue;
        const node = executionNodeId === 'local' ? undefined : getNode(executionNodeId);
        if (
          executionNodeId !== 'local' &&
          (!owner ||
            !assigned.has(executionNodeId) ||
            node?.nativeSessions?.ownerPrincipalId !== owner ||
            !node.nativeAuthority?.valid())
        )
          continue;
        const vars = await loadSlotVars(slot.id, snapshot.poolBySlot.get(slot.id) ?? []);
        contextMachines.set(executionNodeId, pool.machine);
        contexts.push({
          executionNodeId,
          cwd: vars.remoteRepo,
          label: slot.id,
          slotId: slot.id,
          project: vars.projectName,
          supportsProfiles:
            executionNodeId === 'local' || node?.nativeSessions?.supportsProfiles === true,
        });
      }
    }
  }
  return {
    runners: Object.values(KNOWN_RUNNERS)
      .sort(
        (a, b) => Number(b.id === DEFAULT_COPILOT_RUNNER) - Number(a.id === DEFAULT_COPILOT_RUNNER),
      )
      .flatMap((definition) => {
        if (!definition.nativeTransport || !definition.nativeChoices) return [];
        const defaultModel = definition.nativeChoices.defaultModel ?? definition.defaultModel;
        const nodeModels = nativeNodeModels(definition.id, defaultModel, contextMachines);
        const preferences = nativeModelPreferences(
          definition.id,
          definition.nativeChoices.models,
          defaultModel,
        );
        const visibleModelSet = new Set<string>([
          ...preferences.models,
          ...Object.values(nodeModels ?? {}).flat(),
        ]);
        const scopedLabels = nodeModelCatalogs.labels(definition.id, contextMachines.values());
        const modelLabels = Object.fromEntries(
          Object.entries(scopedLabels).filter(([id]) => visibleModelSet.has(id)),
        );
        return [
          {
            runner: definition.id,
            ...(definition.nativeOnly ? { nativeOnly: true } : {}),
            supportsWorkers: allowWorkers && runnerSupportsNativeTaskReuse(definition.id),
            supportsQueuedWorkers: allowWorkers && runnerSupportsNativeTaskReuse(definition.id),
            supportsWorkspaceReviews:
              allowWorkers &&
              runnerSupportsNativeTaskReuse(definition.id) &&
              runnerSupportsReadonlyReviewWorkspace(definition.id),
            ...definition.nativeChoices,
            ...preferences,
            ...(nodeModels ? { nodeModels } : {}),
            ...(Object.keys(modelLabels).length ? { modelLabels } : {}),
          },
        ];
      }),
    contexts,
    ...(executionNodes ? { executionNodes } : {}),
  };
}

/** Why a native session on `executionNodeId` cannot run `model`, from that node's own listing. */
export async function nativeModelNodeBlocker(
  runner: string,
  model: string | undefined,
  executionNodeId: string,
): Promise<string | null> {
  if (!model) return null;
  const snapshot = readMachinePoolSnapshot();
  const machine = executionNodeId === 'local' ? snapshot.localMachines[0] : executionNodeId;
  if (!machine) return null;
  const resolved = snapshot.resolvedByMachine.get(machine);
  if (resolved && !resolved.ok) throw resolved.error;
  return resolved ? runnerModelNodeBlocker(runner, model, machine, 'native') : null;
}

/**
 * Per-node catalogs (Pi, OpenCode): each listed node's picker models, under the same saved
 * preferences and default as `models`. A node that has not listed yet is absent, so its
 * sessions keep `models` (the default, or the saved set).
 */
export function nativeNodeModels(
  runner: string,
  defaultModel: string | null | undefined,
  contextMachines: ReadonlyMap<string, string>,
): Record<string, string[]> | undefined {
  const source = getRunnerDefinition(runner).modelCatalog;
  if (!source || !('nodeCommand' in source)) return undefined;
  const entries = [...contextMachines].flatMap(([executionNodeId, machine]) => {
    const listing = nodeModelCatalogs.nativeListing(runner, machine);
    if (!listing) return [];
    const listed = source.flatCatalog ? [...listing] : listing.filter(isPickerCatalogModel);
    return [
      [
        executionNodeId,
        nativeModelPreferences(runner, listed, defaultModel, listing).models,
      ] as const,
    ];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * A saved visible set replaces the native seed, but a new session's default model stays selectable.
 * The native default wins unless an operator saved one: Pi's terminal default is a bare ID.
 */
export function nativeModelPreferences(
  runner: string,
  seed: string[],
  defaultModel: string | null | undefined,
  availableModels?: readonly string[],
) {
  const visible = describeVisibleModels(runner);
  const source = getRunnerDefinition(runner).modelCatalog;
  const available = (model: string) =>
    !availableModels ||
    availableModels.includes(
      source && 'nodeCommand' in source ? (source.resolveModel?.(model) ?? model) : model,
    );
  const effectiveDefault = (visible.defaultConfigured && visible.defaultModel) || defaultModel;
  const preferred = (visible.configured ? visible.models : seed).filter(available);
  const models = preferred.length || !availableModels ? preferred : seed;
  return {
    defaultModel: effectiveDefault ?? '',
    models:
      effectiveDefault && available(effectiveDefault) && !models.includes(effectiveDefault)
        ? [effectiveDefault, ...models]
        : models,
  };
}

/** Resolve workspace ownership through the same authenticated session/worker route as the read. */
export async function resolveObservedNativeWorkspace(
  principal: import('@farmslot/protocol').Principal,
  params: Record<string, unknown>,
): Promise<import('../resources/workspace-read.js').NativeWorkspaceIdentity> {
  const { nativeSessionRoute } = await loadNativeSession();
  const { runWithSessionOriginator } = await loadWorkOriginator();
  const { session } = (await runWithSessionOriginator(principal, () =>
    nativeSessionRoute(
      Methods.NATIVE_SESSION_READ,
      {
        ...params,
        limit: 1,
      },
      principal,
    ),
  )) as import('@farmslot/protocol').NativeSessionReadResult;
  if (session.workerManaged && ['closed', 'failed', 'closing'].includes(session.state))
    throw new Error('Current workspace is unavailable for a closed or transferred worker');
  return {
    ownerId: session.ownerPrincipalId,
    sessionId: session.id,
    nodeId: session.executionNodeId,
    cwd: session.cwd,
    generation: session.generation,
    leaseId: session.workerLeaseId,
    profileId: session.profileId,
    accountContextId: session.accountContextId,
    state: ['closed', 'failed', 'closing'].includes(session.state) ? session.state : 'open',
  };
}
