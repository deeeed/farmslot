import { create } from 'zustand';

import { type Run, type RunListResult } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

interface RunStore {
  runs: Run[];
  observation: ResourceQueryState<RunListResult>;
  activeLoading: boolean;
  historyLoading: boolean;
  historyLoaded: boolean;
  setRuns: (runs: Run[]) => void;
}

export const useRunStore = create<RunStore>((set) => ({
  runs: [],
  observation: { status: 'loading' },
  activeLoading: false,
  historyLoading: false,
  historyLoaded: false,

  setRuns: (runs) =>
    set({
      runs,
      activeLoading: false,
      historyLoading: false,
      historyLoaded: false,
    }),
}));
