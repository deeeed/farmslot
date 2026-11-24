import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { normalizeFlowType } from '@farmslot/protocol';

export const FLOW_FILTERS = [
  '',
  'fix-bug',
  'review-pr',
  'qa',
  'dev',
  'pr-complete',
  'update-branch',
] as const;
export type FlowFilter = (typeof FLOW_FILTERS)[number];
/** `product` hides eval runs (the comparison lane). */
export const LANE_FILTERS = ['', 'product', 'production', 'validation', 'comparison'] as const;
export type LaneFilter = (typeof LANE_FILTERS)[number];
export const SORT_OPTIONS = ['newest', 'oldest', 'duration'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export interface RunFilters {
  flow: FlowFilter;
  lane: LaneFilter;
  sort: SortOption;
  search: string;
  tag: string;
}

const STORAGE_KEY = '@farmslot:runFilters';
const DEFAULTS: RunFilters = { flow: '', lane: '', sort: 'newest', search: '', tag: '' };

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback;
}

/**
 * Saved filters as this build can apply them. A choice this build does not know (one a newer
 * build saved, then rolled back by an OTA) falls back to its default instead of hiding every run.
 */
export function restoredRunFilters(saved: Partial<Record<keyof RunFilters, unknown>>): RunFilters {
  // Normalize a legacy persisted flow selection (e.g. pre-rename 'merge-main') so the saved
  // filter still matches runs after a flow rename. Mirrors the gateway store's load-time migration.
  const flow = typeof saved.flow === 'string' && saved.flow ? normalizeFlowType(saved.flow) : '';
  return {
    ...DEFAULTS,
    flow: choice(flow, FLOW_FILTERS, DEFAULTS.flow),
    lane: choice(saved.lane, LANE_FILTERS, DEFAULTS.lane),
    sort: choice(saved.sort, SORT_OPTIONS, DEFAULTS.sort),
    tag: typeof saved.tag === 'string' ? saved.tag : DEFAULTS.tag,
  };
}

interface RunFilterStore {
  filters: RunFilters;
  initialized: boolean;
  accountEpoch: number;
  resetForAccount: () => void;
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
  accountEpoch: 0,
  resetForAccount: () =>
    set((state) => ({
      filters: DEFAULTS,
      initialized: true,
      accountEpoch: state.accountEpoch + 1,
    })),

  init: async () => {
    if (get().initialized) return;
    const epoch = get().accountEpoch;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (get().accountEpoch !== epoch) return;
      if (raw) {
        const merged = restoredRunFilters(JSON.parse(raw));
        set({
          filters: merged,
          initialized: true,
        });
      } else {
        set({ initialized: true });
      }
    } catch (err) {
      if (get().accountEpoch !== epoch) return;
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
