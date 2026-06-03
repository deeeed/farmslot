import { create } from 'zustand';

import type { Run } from '@farmslot/protocol';

interface RunStore {
  runs: Run[];
  setRuns: (runs: Run[]) => void;
  upsertRun: (run: Run) => void;
  removeRun: (id: string) => void;
}

export const useRunStore = create<RunStore>((set, get) => ({
  runs: [],

  setRuns: (runs) => set({ runs }),

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
