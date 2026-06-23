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
  tag: string;
}

const STORAGE_KEY = '@farmslot:runFilters';
const DEFAULTS: RunFilters = { flow: '', lane: '', sort: 'newest', search: '', tag: '' };

interface RunFilterStore {
  filters: RunFilters;
  initialized: boolean;
  init: () => Promise<void>;
  setFlow: (flow: FlowFilter) => void;
  setLane: (lane: LaneFilter) => void;
  setSort: (sort: SortOption) => void;
  setSearch: (search: string) => void;
  setTag: (tag: string) => void;
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
          filters: { ...DEFAULTS, ...parsed, search: '', tag: '' },
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

  setTag: (tag) => {
    const next = { ...get().filters, tag };
    set({ filters: next });
    void persist(next);
  },

  clearAll: () => {
    set({ filters: DEFAULTS });
    void persist(DEFAULTS);
  },

  activeCount: () => {
    const { flow, lane, sort, search, tag } = get().filters;
    let count = 0;
    if (flow) count++;
    if (lane) count++;
    if (sort !== 'newest') count++;
    if (search.trim()) count++;
    if (tag.trim()) count++;
    return count;
  },
}));

async function persist(filters: RunFilters) {
  try {
    const { flow, lane, sort, tag } = filters;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ flow, lane, sort, tag }));
  } catch (err) {
    console.debug('[run-filters] persist failed:', err);
  }
}
