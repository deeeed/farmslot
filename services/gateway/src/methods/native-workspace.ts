import type { NativeSessionCatalogResult } from '@farmslot/protocol';

import { loadSlotVars, poolDir } from '../core/config.js';
import { farmslotRoot, isLocal } from '../core/index.js';
import { getNode } from '../fleet/machine-registry.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { KNOWN_RUNNERS } from '../runners/registry.js';

export {
  nativeWorkspaceChanges,
  nativeWorkspaceDiff,
  nativeWorkspaceList,
} from '@farmslot/agent-runtime/native/workspace';

export async function nativeCatalog(owner: string): Promise<NativeSessionCatalogResult> {
  const contexts: NativeSessionCatalogResult['contexts'] = [
    { cwd: farmslotRoot, label: 'Farmslot checkout' },
  ];
  for (const pool of await loadPoolConfigs(poolDir)) {
    for (const slot of pool.slots) {
      if (!slot.repo) continue;
      const executionNodeId = isLocal(pool.host, pool.machine) ? 'local' : pool.machine;
      if (
        executionNodeId !== 'local' &&
        (!owner || getNode(executionNodeId)?.nativeSessions?.ownerPrincipalId !== owner)
      )
        continue;
      const vars = await loadSlotVars(slot.id);
      contexts.push({
        executionNodeId,
        cwd: vars.remoteRepo,
        label: slot.id,
        slotId: slot.id,
        project: vars.projectName,
      });
    }
  }
  return {
    runners: Object.values(KNOWN_RUNNERS).flatMap((definition) =>
      definition.nativeTransport && definition.nativeChoices
        ? [
            {
              runner: definition.id,
              defaultModel: definition.defaultModel ?? '',
              ...definition.nativeChoices,
            },
          ]
        : [],
    ),
    contexts,
  };
}
