import { create } from 'zustand';

import type { PRStatus } from '@farmslot/protocol';

interface PRStore {
  prs: PRStatus[];
  updatedAt: number | null;
  loading: boolean;
  lastError: string | null;
  setPRs: (prs: PRStatus[]) => void;
  upsertPR: (pr: PRStatus) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

function samePRKey(left: Pick<PRStatus, 'repo' | 'pr'>, right: Pick<PRStatus, 'repo' | 'pr'>) {
  return left.repo === right.repo && left.pr === right.pr;
}

export const usePRStore = create<PRStore>((set, get) => ({
  prs: [],
  updatedAt: null,
  loading: false,
  lastError: null,

  setPRs: (prs) => {
    set({ prs, updatedAt: Date.now(), loading: false, lastError: null });
  },

  upsertPR: (pr) => {
    const current = get().prs;
    const index = current.findIndex((item) => samePRKey(item, pr));
    set({
      prs: index >= 0 ? current.map((item, i) => (i === index ? pr : item)) : [...current, pr],
      updatedAt: Date.now(),
      lastError: null,
    });
  },

  setLoading: (loading) => set({ loading }),

  setError: (error) => set(error ? { lastError: error, loading: false } : { lastError: null }),
}));
