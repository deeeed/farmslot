import { create } from 'zustand';

import type { PendingDecision } from '@farmslot/protocol';

interface DecisionStore {
  decisions: PendingDecision[];
  setDecisions: (decisions: PendingDecision[]) => void;
  addDecision: (d: PendingDecision) => void;
  upsertDecision: (d: PendingDecision) => void;
  removeDecision: (id: string) => void;
}

export const useDecisionStore = create<DecisionStore>((set, get) => ({
  decisions: [],

  setDecisions: (decisions) => set({ decisions }),

  addDecision: (d) => {
    const { decisions } = get();
    if (!decisions.find((e) => e.id === d.id)) {
      set({ decisions: [d, ...decisions] });
    }
  },

  upsertDecision: (d) => {
    const { decisions } = get();
    const existingIndex = decisions.findIndex((e) => e.id === d.id);
    if (existingIndex === -1) {
      set({ decisions: [d, ...decisions] });
      return;
    }
    set({ decisions: decisions.map((existing) => (existing.id === d.id ? d : existing)) });
  },

  removeDecision: (id) => {
    set({ decisions: get().decisions.filter((d) => d.id !== id) });
  },
}));
