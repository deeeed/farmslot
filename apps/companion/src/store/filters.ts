import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import type { PendingDecision, Run, SlotStatus } from '@farmslot/protocol';



export const GLOBAL_FILTERS_STORAGE_KEY = '@farmslot:globalFilters';

export interface GlobalFilters {
  projects: string[];
  machines: string[];
}

export interface FilterSource {
  project?: string | null;
  machine?: string | null;
}

export interface SlotFilterContext {
  project: string;
  machine: string;
}

export interface FilterPersistenceStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

type FilterSourceInput = FilterSource[] | (() => FilterSource[]);

export interface LoadedPersistedFilters {
  savedFilters: GlobalFilters;
  filters: GlobalFilters;
  available: GlobalFilters;
  shouldPersistReconciled: boolean;
}

interface FilterStore {
  filters: GlobalFilters;
  availableProjects: string[];
  availableMachines: string[];
  availableSources: FilterSource[];
  editorExpanded: boolean;
  initializing: boolean;
  initialized: boolean;
  mutationVersion: number;
  lastPersistenceError: string | null;
  init: () => Promise<void>;
  toggleProject: (project: string) => void;
  toggleMachine: (machine: string) => void;
  clearAll: () => void;
  setAvailable: (sources: FilterSource[]) => void;
  setEditorExpanded: (expanded: boolean) => void;
}

export function createFilterStore(storage: FilterPersistenceStorage = AsyncStorage) {
  return create<FilterStore>((set, get) => ({
    filters: { projects: [], machines: [] },
    availableProjects: [],
    availableMachines: [],
    availableSources: [],
    editorExpanded: false,
    initializing: false,
    initialized: false,
    mutationVersion: 0,
    lastPersistenceError: null,

    init: async () => {
      if (get().initialized || get().initializing) return;
      const startedMutationVersion = get().mutationVersion;
      set({ initializing: true });
      try {
        const next = await loadPersistedFilters(storage, () => get().availableSources);
        if (get().mutationVersion !== startedMutationVersion) {
          const available = deriveAvailableFilters(get().availableSources, get().filters);
          set({
            availableProjects: available.projects,
            availableMachines: available.machines,
            initialized: true,
            initializing: false,
            lastPersistenceError: null,
          });
          return;
        }
        set({
          filters: next.filters,
          availableProjects: next.available.projects,
          availableMachines: next.available.machines,
          initialized: true,
          initializing: false,
          lastPersistenceError: null,
        });
        if (next.shouldPersistReconciled) void persistFilters(next.filters, set, storage);
      } catch (error) {
        set({
          initialized: true,
          initializing: false,
          lastPersistenceError: `Failed to load global filters: ${(error as Error).message}`,
        });
      }
    },

    toggleProject: (project) => {
      const { filters } = get();
      const projects = filters.projects.includes(project)
        ? filters.projects.filter((p) => p !== project)
        : [...filters.projects, project];
      const next = { ...filters, projects };
      const available = deriveAvailableFilters(get().availableSources, next);
      set({
        filters: next,
        availableProjects: available.projects,
        availableMachines: available.machines,
        mutationVersion: get().mutationVersion + 1,
      });
      void persistFilters(next, set, storage);
    },

    toggleMachine: (machine) => {
      const { filters } = get();
      const machines = filters.machines.includes(machine)
        ? filters.machines.filter((m) => m !== machine)
        : [...filters.machines, machine];
      const next = { ...filters, machines };
      const available = deriveAvailableFilters(get().availableSources, next);
      set({
        filters: next,
        availableProjects: available.projects,
        availableMachines: available.machines,
        mutationVersion: get().mutationVersion + 1,
      });
      void persistFilters(next, set, storage);
    },

    clearAll: () => {
      const next = { projects: [], machines: [] };
      const available = deriveAvailableFilters(get().availableSources, next);
      set({
        filters: next,
        availableProjects: available.projects,
        availableMachines: available.machines,
        mutationVersion: get().mutationVersion + 1,
      });
      void persistFilters(next, set, storage);
    },

    setAvailable: (sources) => {
      const normalizedSources = normalizeFilterSources(sources);
      const next = reconcileFiltersWithSources(get().filters, normalizedSources);
      const filtersChanged = !sameFilters(get().filters, next.filters);
      set({
        availableSources: normalizedSources,
        availableProjects: next.available.projects,
        availableMachines: next.available.machines,
        filters: next.filters,
      });
      if (get().initialized && filtersChanged) void persistFilters(next.filters, set, storage);
    },

    setEditorExpanded: (editorExpanded) => {
      set({ editorExpanded });
    },
  }));
}

export const useFilterStore = createFilterStore();

/** Apply global filters to a slot list */
export function filterSlots<T extends { project?: string | null; machine?: string | null }>(
  slots: T[],
  filters: GlobalFilters,
): T[] {
  const normalized = normalizeFilters(filters);
  return slots.filter((s) => {
    if (normalized.projects.length > 0 && !normalized.projects.includes(s.project ?? '')) return false;
    if (normalized.machines.length > 0 && !normalized.machines.includes(s.machine ?? ''))
      return false;
    return true;
  });
}

export function filterRuns(
  runs: Run[],
  filters: GlobalFilters,
  slotById: Map<string, SlotFilterContext>,
): Run[] {
  const normalized = normalizeFilters(filters);
  return runs.filter((run) => {
    if (normalized.projects.length > 0 && !normalized.projects.includes(run.project)) return false;
    if (normalized.machines.length > 0) {
      const context = run.slotId ? slotById.get(run.slotId) : undefined;
      const machine = context?.machine ?? getMachineFromSlotId(run.slotId);
      if (!machine || !normalized.machines.includes(machine)) return false;
    }
    return true;
  });
}

export function filterDecisions(
  decisions: PendingDecision[],
  filters: GlobalFilters,
  slotById: Map<string, SlotFilterContext>,
): PendingDecision[] {
  const normalized = normalizeFilters(filters);
  return decisions.filter((decision) => {
    const context = decision.slotId ? slotById.get(decision.slotId) : undefined;
    const project = context?.project ?? getDecisionContextString(decision.context, 'project');
    const machine =
      context?.machine ??
      getDecisionContextString(decision.context, 'machine') ??
      getMachineFromSlotId(decision.slotId);
    if (normalized.projects.length > 0 && (!project || !normalized.projects.includes(project))) {
      return false;
    }
    if (normalized.machines.length > 0 && (!machine || !normalized.machines.includes(machine))) {
      return false;
    }
    return true;
  });
}

export function deriveAvailableFilters(
  sources: FilterSource[],
  filters: GlobalFilters,
): GlobalFilters {
  const normalized = normalizeFilters(filters);
  const projectSources =
    normalized.machines.length > 0
      ? sources.filter((source) => source.machine && normalized.machines.includes(source.machine))
      : sources;
  const machineSources =
    normalized.projects.length > 0
      ? sources.filter((source) => source.project && normalized.projects.includes(source.project))
      : sources;
  return {
    projects: uniqueSorted([
      ...projectSources.map((source) => source.project ?? ''),
      ...normalized.projects,
    ]),
    machines: uniqueSorted([
      ...machineSources.map((source) => source.machine ?? ''),
      ...normalized.machines,
    ]),
  };
}

export function pruneFilters(filters: GlobalFilters, _sources: FilterSource[]): GlobalFilters {
  // Global filters are an explicit operator preference and must survive transient fleet
  // source changes, profile switches, and disconnected startup. Keep selected values even
  // when the current source list cannot prove they still exist; the UI can show zero-match
  // state and lets the operator clear filters intentionally.
  return normalizeFilters(filters);
}

export function reconcileFiltersWithSources(
  filters: GlobalFilters,
  sources: FilterSource[],
): { filters: GlobalFilters; available: GlobalFilters } {
  const normalizedSources = normalizeFilterSources(sources);
  const prunedFilters = pruneFilters(filters, normalizedSources);
  return {
    filters: prunedFilters,
    available: deriveAvailableFilters(normalizedSources, prunedFilters),
  };
}

export function normalizeFilters(value: unknown): GlobalFilters {
  const candidate = value as Partial<GlobalFilters> | null;
  return {
    projects: uniqueSorted(
      Array.isArray(candidate?.projects)
        ? candidate.projects
            .filter((project): project is string => typeof project === 'string')
            .map((project) => (project === 'farmslot' ? 'farmslot-farm' : project))
        : [],
    ),
    machines: uniqueSorted(
      Array.isArray(candidate?.machines)
        ? candidate.machines.filter((machine): machine is string => typeof machine === 'string')
        : [],
    ),
  };
}

export function buildGlobalFilterSources({
  slots,
  runs,
  decisions,
}: {
  slots: Array<Pick<SlotStatus, 'slot' | 'project' | 'machine'>>;
  runs: Run[];
  decisions: PendingDecision[];
}): FilterSource[] {
  const sources: FilterSource[] = [];
  const slotById = new Map<string, SlotFilterContext>();

  for (const slot of slots) {
    const project = normalizeFilterValue(slot.project);
    const machine = normalizeFilterValue(slot.machine);
    if (slot.slot && project && machine) {
      slotById.set(slot.slot, { project, machine });
    }
    sources.push({ project, machine });
  }

  for (const run of runs) {
    const slotContext = run.slotId ? slotById.get(run.slotId) : undefined;
    sources.push({
      project: normalizeFilterValue(run.project),
      machine: slotContext?.machine ?? getMachineFromSlotId(run.slotId),
    });
  }

  for (const decision of decisions) {
    const slotContext = decision.slotId ? slotById.get(decision.slotId) : undefined;
    sources.push({
      project:
        slotContext?.project ??
        normalizeFilterValue(getDecisionContextString(decision.context, 'project')),
      machine:
        slotContext?.machine ??
        normalizeFilterValue(getDecisionContextString(decision.context, 'machine')) ??
        getMachineFromSlotId(decision.slotId),
    });
  }

  return normalizeFilterSources(sources);
}

function normalizeFilterSources(sources: FilterSource[]): FilterSource[] {
  const byKey = new Map<string, FilterSource>();
  for (const source of sources) {
    const project = normalizeFilterValue(source.project);
    const machine = normalizeFilterValue(source.machine);
    if (!project && !machine) continue;
    byKey.set(`${project ?? ''}\0${machine ?? ''}`, {
      ...(project ? { project } : {}),
      ...(machine ? { machine } : {}),
    });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (a.project ?? '').localeCompare(b.project ?? '') ||
      (a.machine ?? '').localeCompare(b.machine ?? ''),
  );
}

function normalizeFilterValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getMachineFromSlotId(slotId: string | null | undefined): string | undefined {
  const normalized = normalizeFilterValue(slotId);
  if (!normalized) return undefined;
  const parts = normalized.split('-').filter(Boolean);
  if (parts.length < 3) return undefined;
  return normalizeFilterValue(parts.slice(0, -2).join('-'));
}

async function persistFilters(
  next: GlobalFilters,
  set: (state: Partial<FilterStore>) => void,
  storage: FilterPersistenceStorage,
) {
  try {
    await savePersistedFilters(storage, next);
    set({ lastPersistenceError: null });
  } catch (error) {
    set({
      lastPersistenceError: `Failed to save global filters: ${(error as Error).message}`,
    });
  }
}

export async function loadPersistedFilters(
  storage: FilterPersistenceStorage,
  sources: FilterSourceInput,
): Promise<LoadedPersistedFilters> {
  const raw = await storage.getItem(GLOBAL_FILTERS_STORAGE_KEY);
  const parsed = parsePersistedFilters(raw);
  const savedFilters = parsed.filters;
  const currentSources = typeof sources === 'function' ? sources() : sources;
  const next = reconcileFiltersWithSources(savedFilters, currentSources);
  return {
    savedFilters,
    filters: next.filters,
    available: next.available,
    shouldPersistReconciled: parsed.shouldRewrite || !sameFilters(savedFilters, next.filters),
  };
}

export async function savePersistedFilters(
  storage: FilterPersistenceStorage,
  filters: GlobalFilters,
): Promise<void> {
  await storage.setItem(GLOBAL_FILTERS_STORAGE_KEY, JSON.stringify(normalizeFilters(filters)));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function parsePersistedFilters(raw: string | null): {
  filters: GlobalFilters;
  shouldRewrite: boolean;
} {
  if (!raw) return { filters: { projects: [], machines: [] }, shouldRewrite: false };
  try {
    return { filters: normalizeFilters(JSON.parse(raw)), shouldRewrite: false };
  } catch {
    // User/dev builds can carry malformed AsyncStorage payloads across app versions.
    // Resetting to an empty normalized payload keeps the global filter UI usable and
    // lets init rewrite the bad value through the normal persistence path.
    return { filters: { projects: [], machines: [] }, shouldRewrite: true };
  }
}

function getDecisionContextString(
  context: PendingDecision['context'],
  key: 'project' | 'machine',
): string | undefined {
  const value = context[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sameFilters(left: GlobalFilters, right: GlobalFilters): boolean {
  const normalizedLeft = normalizeFilters(left);
  const normalizedRight = normalizeFilters(right);
  return (
    sameStringArray(normalizedLeft.projects, normalizedRight.projects) &&
    sameStringArray(normalizedLeft.machines, normalizedRight.machines)
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
