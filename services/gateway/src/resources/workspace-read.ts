import { AsyncLocalStorage } from 'node:async_hooks';

import { Methods } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { isLocal, loadSlotVars } from '../core/index.js';
import { GatewayMethodError } from '../core/method-error.js';
import { getNode } from '../fleet/machine-registry.js';
import { loadFleetStatus } from '../fleet/state.js';
import { getRun } from '../runs/store.js';

import { armNodeWorkspace } from './workspace-node-observations.js';
import {
  type WorkspaceBinding,
  workspaceObservations,
  workspaceSourceId,
} from './workspace-observations.js';

const observed = new AsyncLocalStorage<boolean>();
export const isWorkspaceObservedRead = () => observed.getStore() === true;
export const workspaceReadMethods: readonly string[] = [
  Methods.FS_LIST,
  Methods.FS_READ,
  Methods.GIT_STATUS,
  Methods.GIT_DIFF,
  Methods.GIT_SHOW,
  Methods.GIT_BRANCH_DIFF,
];
export const nativeWorkspaceReadMethods: readonly string[] = [
  Methods.NATIVE_SESSION_WORKSPACE_LIST,
  Methods.NATIVE_SESSION_WORKSPACE_READ,
  Methods.NATIVE_SESSION_WORKSPACE_CHANGES,
  Methods.NATIVE_SESSION_WORKSPACE_DIFF,
];

/** Server supplies an authenticated native resolver; no client-created owner or cwd is accepted. */
export interface NativeWorkspaceIdentity {
  ownerId: string;
  sessionId: string;
  nodeId: string;
  cwd: string;
  generation: string;
  leaseId?: string;
  profileId?: string;
  accountContextId: string;
  state: string;
}
export async function captureWorkspaceRead(
  params: Record<string, unknown>,
  keys: ResourceKey[],
  resolveNative?: () => Promise<NativeWorkspaceIdentity>,
): Promise<() => Promise<void>> {
  let binding: WorkspaceBinding;
  if (resolveNative) {
    const initial = await resolveNative();
    const identity = JSON.stringify(initial);
    const node = initial.nodeId === 'local' ? undefined : getNode(initial.nodeId);
    if (initial.nodeId !== 'local' && !node)
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNAVAILABLE',
        'Native workspace node disconnected',
      );
    binding = {
      root: initial.cwd,
      keys: keys.filter((key) => key.family === 'workspace'),
      sourceId: workspaceSourceId(initial.nodeId, initial.cwd),
      current: async () =>
        JSON.stringify(await resolveNative()) === identity &&
        (!node || (getNode(node.machine) === node && node.nativeAuthority?.valid() === true)),
      ...(node
        ? {
            arm: (changed: () => void, failed: (error: Error) => void) =>
              armNodeWorkspace(node, initial.cwd, changed, failed, initial.ownerId),
          }
        : {}),
    };
  } else {
    const slotId = String(params.slotId ?? '');
    if (!slotId)
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNSUPPORTED',
        'Frozen run Git reads retain their existing owning artifact contract',
      );
    const resolve = async () => {
      const vars = await loadSlotVars(slotId);
      const slot = (await loadFleetStatus(false, true)).slots.find(
        (entry) => entry.slot === slotId,
      );
      const run = slot?.currentRunId ? getRun(slot.currentRunId) : undefined;
      return {
        vars,
        identity: JSON.stringify([
          vars.machine,
          vars.host,
          vars.remoteRepo,
          slot?.currentRunId,
          run?.engineState?.generation,
          run?.nativeOwnerPrincipalId,
          run?.agentContexts,
        ]),
      };
    };
    const initial = await resolve();
    const slot = (await loadFleetStatus(false, true)).slots.find((entry) => entry.slot === slotId);
    if (params.runId && slot?.currentRunId !== params.runId)
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNAVAILABLE',
        'Run no longer owns this slot workspace',
      );
    const node = isLocal(initial.vars.host, initial.vars.machine)
      ? undefined
      : getNode(initial.vars.machine);
    if (!isLocal(initial.vars.host, initial.vars.machine) && !node)
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNAVAILABLE',
        'Workspace node disconnected',
      );
    binding = {
      root: initial.vars.remoteRepo,
      keys: keys.filter((key) => key.family === 'workspace'),
      sourceId: workspaceSourceId(initial.vars.machine, initial.vars.remoteRepo),
      current: async () =>
        (await resolve()).identity === initial.identity &&
        (!node || (getNode(node.machine) === node && node.observationAuthority?.() !== false)),
      ...(node
        ? {
            arm: (changed: () => void, failed: (error: Error) => void) =>
              armNodeWorkspace(node, initial.vars.remoteRepo, changed, failed),
          }
        : {}),
    };
  }
  return workspaceObservations.capture(binding);
}
export function runWorkspaceObservedRead<T>(read: () => Promise<T>): Promise<T> {
  return observed.run(true, read);
}
