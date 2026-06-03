import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

export type FlowFilter = '' | 'fix-bug' | 'review-pr' | 'dev' | 'pr-complete' | 'merge-main';
export type LaneFilter = '' | 'production' | 'validation' | 'comparison';
export type SortOption = 'newest' | 'oldest' | 'duration';

export interface RunFilters {
  flow: FlowFilter;
  lane: LaneFilter;
  sort: SortOption;
  search: string;
}

const STORAGE_KEY = '@farmslot:runFilters';
const DEFAULTS: RunFilters = { flow: '', lane: '', sort: 'newest', search: '' };

interface RunFilterStore {
  filters: RunFilters;
  initialized: boolean;
  init: () => Promise<void>;
  setFlow: (flow: FlowFilter) => void;
  setLane: (lane: LaneFilter) => void;
  setSort: (sort: SortOption) => void;
  setSearch: (search: string) => void;
  clearAll: () => void;
  activeCount: () => number;
}

export const useRunFilterStore = create<RunFilterStore>((set, get) => ({
  filters: DEFAULTS,
  initialized: false,

  init: async () => {
    if (get().initialized) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({
          filters: { ...DEFAULTS, ...parsed, search: '' },
          initialized: true,
        });
      } else {
        set({ initialized: true });
      }
    } catch (err) {
      console.debug('[run-filters] init parse error:', err);
      set({ initialized: true });
    }
  },

  setFlow: (flow) => {
    const next = { ...get().filters, flow };
    set({ filters: next });
    void persist(next);
  },

  setLane: (lane) => {
    const next = { ...get().filters, lane };
    set({ filters: next });
    void persist(next);
  },

  setSort: (sort) => {
    const next = { ...get().filters, sort };
    set({ filters: next });
    void persist(next);
  },

  setSearch: (search) => {
    set({ filters: { ...get().filters, search } });
  },

  clearAll: () => {
    set({ filters: DEFAULTS });
    void persist(DEFAULTS);
  },

  activeCount: () => {
    const { flow, lane, sort, search } = get().filters;
    let count = 0;
    if (flow) count++;
    if (lane) count++;
    if (sort !== 'newest') count++;
    if (search.trim()) count++;
    return count;
  },
}));

async function persist(filters: RunFilters) {
  try {
    const { flow, lane, sort } = filters;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ flow, lane, sort }));
  } catch (err) {
    console.debug('[run-filters] persist failed:', err);
  }
}
