import { create } from 'zustand';

import type { DecisionListResult, PendingDecision } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

interface DecisionStore {
  decisions: PendingDecision[];
  observation: ResourceQueryState<DecisionListResult>;
  setDecisions: (decisions: PendingDecision[]) => void;
}

export const useDecisionStore = create<DecisionStore>((set) => ({
  decisions: [],
  observation: { status: 'loading' },

  setDecisions: (decisions) => set({ decisions }),
}));
