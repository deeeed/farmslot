import type { NativeSessionCatalogResult } from '@farmslot/protocol';

import { loadSlotVars, poolDir } from '../core/config.js';
import { farmslotRoot, isLocal } from '../core/index.js';
import { getNode } from '../fleet/machine-registry.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { runnerSupportsReadonlyReviewWorkspace } from '../runners/native/review-workspace.js';
import {
  DEFAULT_COPILOT_RUNNER,
  KNOWN_RUNNERS,
  runnerSupportsNativeTaskReuse,
} from '../runners/registry.js';
import { describeVisibleModels } from '../runners/visible-models.js';
import { ownsLocalNativeProfile } from '../security/native-owner.js';

export {
  nativeWorkspaceChanges,
  nativeWorkspaceDiff,
  nativeWorkspaceList,
} from '@farmslot/agent-runtime/native/workspace';

export async function nativeCatalog(
  owner: string,
  allowWorkers = true,
): Promise<NativeSessionCatalogResult> {
  const contexts: NativeSessionCatalogResult['contexts'] = [
    ...(ownsLocalNativeProfile(owner)
      ? [{ cwd: farmslotRoot, label: 'Farmslot checkout', supportsProfiles: true }]
      : []),
  ];
  for (const pool of await loadPoolConfigs(poolDir)) {
    for (const slot of pool.slots) {
      if (!slot.repo) continue;
      const executionNodeId = isLocal(pool.host, pool.machine) ? 'local' : pool.machine;
      if (executionNodeId === 'local' && !ownsLocalNativeProfile(owner)) continue;
      const node = executionNodeId === 'local' ? undefined : getNode(executionNodeId);
      if (
        executionNodeId !== 'local' &&
        (!owner ||
          node?.nativeSessions?.ownerPrincipalId !== owner ||
          !node.nativeAuthority?.valid())
      )
        continue;
      const vars = await loadSlotVars(slot.id);
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
      .flatMap((definition) =>
        definition.nativeTransport && definition.nativeChoices
          ? [
              {
                runner: definition.id,
                defaultModel: definition.defaultModel ?? '',
                supportsWorkers: allowWorkers && runnerSupportsNativeTaskReuse(definition.id),
                supportsQueuedWorkers: allowWorkers && runnerSupportsNativeTaskReuse(definition.id),
                supportsWorkspaceReviews:
                  allowWorkers &&
                  runnerSupportsNativeTaskReuse(definition.id) &&
                  runnerSupportsReadonlyReviewWorkspace(definition.id),
                ...definition.nativeChoices,
                models: visibleNativeModels(definition.id, definition.nativeChoices?.models ?? []),
              },
            ]
          : [],
      ),
    contexts,
  };
}

function visibleNativeModels(runner: string, seed: string[]): string[] {
  const visible = describeVisibleModels(runner);
  return visible.configured ? visible.models : seed;
}
