import {
  isPickerCatalogModel,
  type NativeSessionCatalogResult,
  type NativeSessionExecutionNode,
  type Principal,
} from '@farmslot/protocol';
import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { loadSlotVars } from '../core/config.js';
import { farmslotRoot, isLocal } from '../core/index.js';
import { getNode } from '../fleet/machine-registry.js';
import { loadPoolConfigs } from '../fleet/state.js';
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
import { loadCredentialStore } from '../security/credential-store.js';
import { nativeOwnerAssignedMachines } from '../security/native-node.js';
import { ownsLocalNativeProfile } from '../security/native-owner.js';

import { standaloneCatalogTargets } from './native-catalog-targets.js';

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
  const assigned = nativeOwnerAssignedMachines(loadCredentialStore().principals, owner);
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
  } else
    for (const pool of await loadPoolConfigs(currentFarmPaths('gateway').pool)) {
      for (const slot of pool.slots) {
        if (!slot.repo) continue;
        const executionNodeId =
          isLocal(pool.host, pool.machine) && ownsLocalNativeProfile(owner)
            ? 'local'
            : pool.machine;
        if (executionNodeId === 'local' && !ownsLocalNativeProfile(owner)) continue;
        const node = executionNodeId === 'local' ? undefined : getNode(executionNodeId);
        if (
          executionNodeId !== 'local' &&
          (!owner ||
            !assigned.has(executionNodeId) ||
            node?.nativeSessions?.ownerPrincipalId !== owner ||
            !node.nativeAuthority?.valid())
        )
          continue;
        const vars = await loadSlotVars(slot.id);
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
  return {
    runners: Object.values(KNOWN_RUNNERS)
      .sort(
        (a, b) => Number(b.id === DEFAULT_COPILOT_RUNNER) - Number(a.id === DEFAULT_COPILOT_RUNNER),
      )
      .flatMap((definition) => {
        if (!definition.nativeTransport || !definition.nativeChoices) return [];
        const defaultModel = definition.nativeChoices.defaultModel ?? definition.defaultModel;
        const nodeModels = nativeNodeModels(definition.id, defaultModel, contextMachines);
        return [
          {
            runner: definition.id,
            supportsWorkers: allowWorkers && runnerSupportsNativeTaskReuse(definition.id),
            supportsQueuedWorkers: allowWorkers && runnerSupportsNativeTaskReuse(definition.id),
            supportsWorkspaceReviews:
              allowWorkers &&
              runnerSupportsNativeTaskReuse(definition.id) &&
              runnerSupportsReadonlyReviewWorkspace(definition.id),
            ...definition.nativeChoices,
            ...nativeModelPreferences(definition.id, definition.nativeChoices.models, defaultModel),
            ...(nodeModels ? { nodeModels } : {}),
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
  for (const pool of await loadPoolConfigs(currentFarmPaths('gateway').pool))
    if (
      pool.machine === executionNodeId ||
      (executionNodeId === 'local' && isLocal(pool.host, pool.machine))
    )
      return runnerModelNodeBlocker(runner, model, pool.machine);
  return null;
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
    const listing = nodeModelCatalogs.listing(runner, machine);
    if (!listing) return [];
    const listed = listing.filter(isPickerCatalogModel);
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
  const { nativeSessionRoute } = await import('./native-session.js');
  const { Methods } = await import('@farmslot/protocol');
  const { runWithSessionOriginator } = await import('../security/work-originator.js');
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
