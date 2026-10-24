import { Methods, type NativeWorkerControlTarget } from '@farmslot/protocol';
import { type ResourceKey, resourceKeyId } from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';
import { nativeWorkerHistoryBinding } from '../runners/native/worker-history.js';
import { getRun } from '../runs/store.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import { authorizeGatewayMethod } from '../security/authorization.js';
import { loadCredentialStore } from '../security/credential-store.js';
import {
  nativeOwnerAssignedMachines,
  requireGenerationZeroOwner,
} from '../security/native-node.js';
import { nativeOwnerCanUseWorkers, ownsLocalNativeProfile } from '../security/native-owner.js';
import {
  assertNativeRunOwner,
  resolveReviewWorkspaceOwner,
} from '../security/native-worker-owner.js';
import { runWithSessionOriginator } from '../security/work-originator.js';
import type { ClientState } from '../server/client-state.js';

import type { NativeWorkspaceIdentity } from './workspace-read.js';

interface AuthorizedWorkspaceAlias {
  authentication: ClientState['authentication'];
  clientKind: ClientState['clientKind'];
  identity: NativeWorkspaceIdentity;
  worker?: NativeWorkerControlTarget;
}
// A different ClientState/socket cannot inherit an alias. Weak ownership ends on disconnect.
const aliases = new WeakMap<ClientState, Map<string, AuthorizedWorkspaceAlias>>();

/** Call only after the exact existing route, source fence and final authority check succeeded. */
export function registerWorkspaceReadAlias(
  state: ClientState,
  key: ResourceKey,
  identity: NativeWorkspaceIdentity,
): void {
  if (key.family !== 'workspace' || !('sessionId' in key)) return;
  if (key.nodeId !== identity.nodeId || key.sessionId !== identity.sessionId)
    throw new Error('Workspace alias does not match the authorized read');
  const entries = aliases.get(state) ?? new Map<string, AuthorizedWorkspaceAlias>();
  if (entries.size >= 200 && !entries.has(resourceKeyId(key)))
    entries.delete(entries.keys().next().value!);
  entries.set(resourceKeyId(key), {
    authentication: state.authentication,
    clientKind: state.clientKind,
    identity: { ...identity },
    ...(key.contextId ? { worker: JSON.parse(key.contextId) as NativeWorkerControlTarget } : {}),
  });
  aliases.set(state, entries);
}

/** Authorization deliberately uses local authority, never a remote read or producer health. */
export async function canReadWorkspaceResourceKey(
  runtime: GatewayAuthRuntime,
  state: ClientState,
  key: ResourceKey,
): Promise<boolean> {
  if (key.family !== 'workspace') return false;
  try {
    if ('slotId' in key) {
      authorizeGatewayMethod(runtime, state, Methods.FS_LIST);
      return true;
    }
    if (!('sessionId' in key)) return false;
    const principal = authorizeGatewayMethod(runtime, state, Methods.NATIVE_SESSION_WORKSPACE_LIST);
    const alias = aliases.get(state)?.get(resourceKeyId(key));
    if (
      !alias ||
      key.ownerId !== principal.id ||
      alias.authentication !== state.authentication ||
      alias.clientKind !== state.clientKind
    )
      return false;
    return await runWithSessionOriginator(principal, async () => {
      const identity = alias.identity;
      requireGenerationZeroOwner(identity.ownerId);
      // Assignment authority survives transport/source failure so its invalidation is delivered.
      if (identity.nodeId === 'local') {
        if (!ownsLocalNativeProfile(identity.ownerId)) return false;
      } else if (
        !nativeOwnerAssignedMachines(loadCredentialStore().principals, identity.ownerId).has(
          identity.nodeId,
        )
      )
        return false;
      if (alias.worker) {
        if (!nativeOwnerCanUseWorkers(principal)) return false;
        const run = getRun(alias.worker.runId);
        if (!run) return false;
        assertNativeRunOwner(run);
        const selected = nativeWorkerHistoryBinding(run, alias.worker);
        const binding = selected?.binding;
        if (
          !binding ||
          selected!.readOnly ||
          binding.recovery ||
          binding.sessionId !== identity.sessionId ||
          binding.executionNodeId !== identity.nodeId ||
          binding.ownerPrincipalId !== identity.ownerId ||
          binding.generation !== identity.generation ||
          binding.leaseId !== identity.leaseId ||
          (binding.profile !== undefined &&
            (binding.profile.profileId !== identity.profileId ||
              binding.profile.accountContextId !== identity.accountContextId))
        )
          return false;
        if (run.transport !== 'native') resolveReviewWorkspaceOwner(binding.ownerPrincipalId);
        return true;
      }
      if (principal.id !== identity.ownerId) return false;
      // Standalone session IDs retain the successful read's exact profile/context pin.
      // Rechecking process/session liveness here would suppress its failure invalidation.
      return true;
    });
  } catch (error) {
    if (
      error instanceof GatewayMethodError &&
      ['AUTH_REQUIRED', 'AUTH_FORBIDDEN'].includes(error.code)
    )
      return false;
    throw error;
  }
}
