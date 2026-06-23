import { create } from 'zustand';

import type { Run } from '@farmslot/protocol';

import { mergeRunsById } from '../lib/gateway-run-sync';

interface RunStore {
  runs: Run[];
  activeLoading: boolean;
  historyLoading: boolean;
  historyLoaded: boolean;
  setRuns: (runs: Run[]) => void;
  mergeRuns: (runs: Run[]) => void;
  setActiveLoading: (loading: boolean) => void;
  setHistoryLoading: (loading: boolean) => void;
  markHistoryLoaded: () => void;
  resetSync: () => void;
  upsertRun: (run: Run) => void;
  removeRun: (id: string) => void;
}

export const useRunStore = create<RunStore>((set, get) => ({
  runs: [],
  activeLoading: false,
  historyLoading: false,
  historyLoaded: false,

  setRuns: (runs) => set({ runs, activeLoading: false }),

  mergeRuns: (runs) => {
    set({
      runs: mergeRunsById(get().runs, runs),
      historyLoading: false,
      historyLoaded: true,
    });
  },

  setActiveLoading: (activeLoading) => set({ activeLoading }),
  setHistoryLoading: (historyLoading) => set({ historyLoading }),
  markHistoryLoaded: () => set({ historyLoaded: true, historyLoading: false }),
  resetSync: () =>
    set({
      runs: [],
      activeLoading: false,
      historyLoading: false,
      historyLoaded: false,
    }),


  upsertRun: (run) => {
    const { runs } = get();
    const idx = runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      const updated = [...runs];
      updated[idx] = run;
      set({ runs: updated });
    } else {
      set({ runs: [run, ...runs] });
    }
  },

  removeRun: (id) => {
    set({ runs: get().runs.filter((r) => r.id !== id) });
  },
}));
