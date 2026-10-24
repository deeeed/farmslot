import { useConnectionStore } from '../store/connection';

import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

/** Read developer counters over the existing recipe relay, without attaching a JS debugger. */
export const observeOfflineClientStoreBaseline: FarmslotRecipeUiObserver = (refs) => {
  if (!__DEV__ || refs.length !== 1 || !refs[0].startsWith('offline-store-baseline'))
    return undefined;
  const state = useConnectionStore.getState();
  const meter = state.client?.offlineBaseline;
  if (refs[0] === 'offline-store-baseline:reconnect') meter?.interrupt();
  const slotId = refs[0].match(/^offline-store-baseline:diff:([a-zA-Z0-9-]+)$/)?.[1];
  if (slotId) meter?.begin('diff', { slotId });
  return {
    observations: {
      offlineBaseline: {
        status: state.status,
        timingSource: meter?.timingSource(),
        samples: meter?.snapshot() ?? [],
      },
    },
  };
};
