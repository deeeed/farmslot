import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { isAbsolute, join } from 'node:path';

import type {
  NativeSessionCatalogResult,
  NativeSessionExecutionNode,
  Principal,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/index.js';
import { GatewayMethodError } from '../core/method-error.js';
import { resolveMachinePoolConfigs } from '../fleet/machine-pool.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { nativeSessionManager } from '../runners/native/manager.js';
import { resolveNativeExecutionNode } from '../runners/native/node.js';
import {
  assertStandaloneAdmin,
  standaloneOwner,
  standaloneOwners,
} from '../security/native-standalone.js';

export interface StandaloneCatalogTargets {
  executionNodes: NativeSessionExecutionNode[];
  contexts: NativeSessionCatalogResult['contexts'];
  contextMachines: Map<string, string>;
}

/** Homes are node metadata reads, not native-host launches or username-derived guesses. */
export async function standaloneCatalogTargets(
  reader: Principal,
): Promise<StandaloneCatalogTargets> {
  const assigned = standaloneOwners(reader);
  const pools = await loadPoolConfigs(currentFarmPaths('gateway').pool);
  // Pools describe fleet workspaces; only issued native targets belong in this catalog.
  const machines = new Set(assigned.keys());
  // Independent target probes run together so one slow node cannot serialize the whole catalog.
  const targets = await Promise.all(
    [...machines].map(async (machine) => {
      const row: NativeSessionExecutionNode = { executionNodeId: machine, label: machine };
      try {
        const owner = standaloneOwner(reader, machine);
        const node = machine === 'local' ? undefined : resolveNativeExecutionNode(owner, machine);
        let result: unknown;
        try {
          result = node
            ? await sendNodeRequest(
                node,
                'native.session.metadata',
                { owner },
                { timeout: 5_000, requireSameConnection: true },
              )
            : nativeSessionManager.metadata();
        } catch (error) {
          // A failed target metadata RPC makes that row unavailable, without hiding other machines.
          throw new GatewayMethodError(
            'NATIVE_SOURCE_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
          );
        }
        if (
          standaloneOwner(reader, machine) !== owner ||
          (node && resolveNativeExecutionNode(owner, machine) !== node)
        )
          throw new GatewayMethodError(
            'NATIVE_SOURCE_UNAVAILABLE',
            'Execution node changed while reading its home',
          );
        if (
          !result ||
          typeof result !== 'object' ||
          !('homeDirectory' in result) ||
          typeof result.homeDirectory !== 'string' ||
          !isAbsolute(result.homeDirectory)
        )
          throw new GatewayMethodError(
            'NATIVE_SOURCE_UNAVAILABLE',
            'Execution node did not report an absolute home directory',
          );
        row.homeDirectory = result.homeDirectory;
        if (
          !('supportsStandaloneDelegation' in result) ||
          result.supportsStandaloneDelegation !== true
        )
          throw new GatewayMethodError(
            'NATIVE_SOURCE_UNAVAILABLE',
            'Refresh the native host for standalone admin sessions',
          );
        return {
          row,
          owner,
          node,
          supportsProfiles: !node || node.nativeSessions.supportsProfiles === true,
        };
      } catch (error) {
        assertStandaloneAdmin(reader);
        if (!(error instanceof GatewayMethodError) && !(error instanceof Error && 'code' in error))
          throw error;
        row.unavailableReason = error.message;
        return { row, supportsProfiles: false };
      }
    }),
  );
  const contexts: NativeSessionCatalogResult['contexts'] = [];
  const contextMachines = new Map<string, string>();
  for (const { row, supportsProfiles } of targets) {
    const home = row.homeDirectory;
    if (row.unavailableReason || home === undefined) continue;
    const machine = row.executionNodeId;
    const targetPools = pools.filter((pool) =>
      machine === 'local' ? isLocal(pool.host, pool.machine) : pool.machine === machine,
    );
    const modelMachine =
      machine === 'local'
        ? resolveMachinePoolConfigs(targetPools).values().next().value?.machine
        : machine;
    if (modelMachine) contextMachines.set(machine, modelMachine);
    contexts.push({
      executionNodeId: machine,
      cwd: home,
      label: 'Home directory',
      supportsProfiles,
    });
    for (const pool of targetPools) {
      for (const slot of pool.slots) {
        if (!slot.repo) continue;
        const vars = await loadSlotVars(slot.id);
        const cwd =
          slot.repo === '~'
            ? home
            : slot.repo.startsWith('~/')
              ? join(home, slot.repo.slice(2))
              : vars.remoteRepo;
        contexts.push({
          executionNodeId: machine,
          cwd,
          label: slot.id,
          slotId: slot.id,
          project: vars.projectName,
          supportsProfiles,
        });
      }
    }
  }
  // Slot metadata also awaits filesystem reads. Fence all targets after the final await.
  for (const { row, owner, node } of targets) {
    if (owner !== undefined && !row.unavailableReason) {
      try {
        if (
          standaloneOwner(reader, row.executionNodeId) !== owner ||
          (node && resolveNativeExecutionNode(owner, row.executionNodeId) !== node)
        )
          throw new GatewayMethodError(
            'NATIVE_SOURCE_UNAVAILABLE',
            'Execution node changed while reading the catalog',
          );
      } catch (error) {
        assertStandaloneAdmin(reader);
        if (!(error instanceof GatewayMethodError) && !(error instanceof Error && 'code' in error))
          throw error;
        row.unavailableReason = error.message;
      }
    }
    if (row.unavailableReason) contextMachines.delete(row.executionNodeId);
  }
  assertStandaloneAdmin(reader);
  const available = new Set(
    targets.filter(({ row }) => !row.unavailableReason).map(({ row }) => row.executionNodeId),
  );
  return {
    executionNodes: targets.map(({ row }) => row),
    contexts: contexts.filter((context) => available.has(context.executionNodeId ?? 'local')),
    contextMachines,
  };
}
