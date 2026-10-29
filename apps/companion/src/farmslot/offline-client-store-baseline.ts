import {
  nativeRunHistoryLimit,
  nativeRunHistoryObservation,
  openNativeRunHistory,
} from '../lib/run-collections';
import { useConnectionStore } from '../store/connection';
import { useRunStore } from '../store/runs';

import { observeD12Native } from './d12-native-proof';
import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

/** Read developer counters over the existing recipe relay, without attaching a JS debugger. */
export const observeOfflineClientStoreBaseline: FarmslotRecipeUiObserver = (refs) => {
  if (!__DEV__ || refs.length !== 1) return undefined;
  if (refs[0].startsWith('run-list-version-fill')) return observeRunListVersionFill(refs[0]);
  if (refs[0].startsWith('d12-native')) return observeD12Native(refs[0]);
  if (!refs[0].startsWith('offline-store-baseline')) return undefined;
  const state = useConnectionStore.getState();
  const meter = state.client?.offlineBaseline;
  if (refs[0] === 'offline-store-baseline:reconnect') meter?.interrupt();
  const slotId = refs[0].match(/^offline-store-baseline:diff:([a-zA-Z0-9-]+)$/)?.[1];
  if (slotId) meter?.begin('diff', { slotId });
  // A version-list read ends at the merged run list, after its last catch-up page.
  const runs = useRunStore.getState().observation;
  return {
    observations: {
      offlineBaseline: {
        status: state.status,
        timingSource: meter?.timingSource(),
        samples: meter?.snapshot() ?? [],
        merged: meter?.merged(runs),
      },
    },
  };
};

/** The run list's version-list fill and catch-up, for run-list-version-fill.recipe.json. */
function observeRunListVersionFill(ref: string) {
  if (ref === 'run-list-version-fill:open-history') void openNativeRunHistory();
  const state = useConnectionStore.getState();
  const client = state.client;
  const meter = client?.offlineBaseline;
  const history = nativeRunHistoryObservation();
  const resourceChanges = client?.authenticatedConnection?.capabilities.resourceChanges;
  return {
    observations: {
      runListVersionFill: {
        status: state.status,
        epoch: resourceChanges?.epoch,
        connectionId: meter?.connection() ?? 0,
        versionLists: resourceChanges ? resourceChanges.versionLists === true : null,
        historyLimit: nativeRunHistoryLimit(),
        history: history && {
          status: history.status,
          observedAt: history.observedAt,
          rows: history.data?.runs.length,
          totalCount: history.data?.totalCount,
        },
        pendingRunLists: meter?.pendingRunLists() ?? 0,
        framesSent: meter?.framesSent() ?? 0,
        frames: meter?.runListFrames() ?? [],
      },
    },
  };
}
