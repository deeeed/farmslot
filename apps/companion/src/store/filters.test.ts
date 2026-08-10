import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingDecision, Run } from '@farmslot/protocol';

import {
  buildGlobalFilterSources,
  createFilterStore,
  filterDecisions,
  filterRuns,
  filterSlots,
  type FilterSource,
  GLOBAL_FILTERS_STORAGE_KEY,
  type GlobalFilters,
  loadPersistedFilters,
  pruneFilters,
  reconcileFiltersWithSources,
  savePersistedFilters,
} from './filters';

const sources: FilterSource[] = [
  { project: 'example-audio-farm', machine: 'runner-local' },
  { project: 'farmslot-farm', machine: 'runner-local' },
  { project: 'example-mobile-farm', machine: 'runner-a' },
];

test('reconcileFiltersWithSources keeps saved filters and derives dependent options', () => {
  const saved: GlobalFilters = { projects: ['example-audio-farm'], machines: [] };

  assert.deepEqual(reconcileFiltersWithSources(saved, sources), {
    filters: { projects: ['example-audio-farm'], machines: [] },
    available: {
      projects: ['example-audio-farm', 'example-mobile-farm', 'farmslot-farm'],
      machines: ['runner-local'],
    },
  });
});

test('reconcileFiltersWithSources preserves saved filters that are absent from current sources', () => {
  const saved: GlobalFilters = {
    projects: ['example-audio-farm', 'missing-project'],
    machines: ['missing-machine', 'runner-local'],
  };

  assert.deepEqual(reconcileFiltersWithSources(saved, sources), {
    filters: {
      projects: ['example-audio-farm', 'missing-project'],
      machines: ['missing-machine', 'runner-local'],
    },
    available: {
      projects: ['example-audio-farm', 'farmslot-farm', 'missing-project'],
      machines: ['missing-machine', 'runner-local'],
    },
  });
});

test('deriveAvailableFilters keeps active chips visible for zero-match combinations', () => {
  assert.deepEqual(
    reconcileFiltersWithSources(
      { projects: ['example-audio-farm'], machines: ['runner-a'] },
      sources,
    ),
    {
      filters: { projects: ['example-audio-farm'], machines: ['runner-a'] },
      available: {
        projects: ['example-audio-farm', 'example-mobile-farm'],
        machines: ['runner-a', 'runner-local'],
      },
    },
  );
});

test('pruneFilters preserves saved filters while fleet sources are temporarily empty', () => {
  assert.deepEqual(
    pruneFilters({ projects: ['example-audio-farm'], machines: ['runner-local'] }, []),
    {
      projects: ['example-audio-farm'],
      machines: ['runner-local'],
    },
  );
});

test('reconcileFiltersWithSources keeps project-only run sources available', () => {
  const saved: GlobalFilters = { projects: ['archived-farm'], machines: [] };

  assert.deepEqual(reconcileFiltersWithSources(saved, [{ project: 'archived-farm' }]), {
    filters: { projects: ['archived-farm'], machines: [] },
    available: { projects: ['archived-farm'], machines: [] },
  });
});

test('buildGlobalFilterSources includes runs and decision context outside active fleet slots', () => {
  const slots = [{ slot: 'slot-a', project: 'example-audio-farm', machine: 'runner-local' }];
  const runs = [
    makeRun({ id: 'run-a', project: 'example-audio-farm', slotId: 'slot-a' }),
    makeRun({ id: 'run-b', project: 'archived-farm', slotId: null }),
  ];
  const decisions = [
    makeDecision({
      id: 'decision-a',
      slotId: null,
      context: { project: 'remote-farm', machine: 'runner-a' },
    }),
  ];

  assert.deepEqual(buildGlobalFilterSources({ slots, runs, decisions }), [
    { project: 'archived-farm' },
    { project: 'example-audio-farm', machine: 'runner-local' },
    { project: 'remote-farm', machine: 'runner-a' },
  ]);
});

test('buildGlobalFilterSources infers machine options from slot ids when fleet context is absent', () => {
  const runs = [
    makeRun({ id: 'run-a', project: 'example-mobile-farm', slotId: 'runner-local-mobile-6' }),
  ];
  const decisions = [makeDecision({ id: 'decision-a', slotId: 'runner-a-mm-2' })];

  assert.deepEqual(buildGlobalFilterSources({ slots: [], runs, decisions }), [
    { machine: 'runner-a' },
    { project: 'example-mobile-farm', machine: 'runner-local' },
  ]);
});

test('filterSlots applies both persisted project and machine filters', () => {
  assert.deepEqual(
    filterSlots(
      [
        { slot: 'one', project: 'example-audio-farm', machine: 'runner-local' },
        { slot: 'two', project: 'example-audio-farm', machine: 'runner-a' },
        { slot: 'three', project: 'farmslot-farm', machine: 'runner-local' },
      ],
      { projects: ['example-audio-farm'], machines: ['runner-local'] },
    ).map((slot) => slot.slot),
    ['one'],
  );
});

test('filterRuns applies project filters directly and machine filters through slot context', () => {
  const runs: Run[] = [
    makeRun({ id: 'run-a', project: 'example-audio-farm', slotId: 'slot-a' }),
    makeRun({ id: 'run-b', project: 'example-audio-farm', slotId: 'slot-b' }),
    makeRun({ id: 'run-c', project: 'farmslot-farm', slotId: 'slot-c' }),
    makeRun({ id: 'run-d', project: 'example-audio-farm', slotId: null }),
  ];
  const slotById = new Map([
    ['slot-a', { project: 'example-audio-farm', machine: 'runner-local' }],
    ['slot-b', { project: 'example-audio-farm', machine: 'runner-a' }],
    ['slot-c', { project: 'farmslot-farm', machine: 'runner-local' }],
  ]);

  assert.deepEqual(
    filterRuns(
      runs,
      { projects: ['example-audio-farm'], machines: ['runner-local'] },
      slotById,
    ).map((run) => run.id),
    ['run-a'],
  );
});

test('filterRuns applies machine filters from slot id before fleet context is available', () => {
  const runs: Run[] = [
    makeRun({ id: 'run-a', project: 'example-mobile-farm', slotId: 'runner-local-mobile-6' }),
    makeRun({ id: 'run-b', project: 'example-mobile-farm', slotId: 'runner-a-mm-2' }),
    makeRun({ id: 'run-c', project: 'example-mobile-farm', slotId: null }),
  ];

  assert.deepEqual(
    filterRuns(runs, { projects: [], machines: ['runner-local'] }, new Map()).map((run) => run.id),
    ['run-a'],
  );
});

test('filterDecisions requires slot context for both project and machine filters', () => {
  const decisions: PendingDecision[] = [
    makeDecision({ id: 'decision-a', slotId: 'slot-a' }),
    makeDecision({ id: 'decision-b', slotId: 'slot-b' }),
    makeDecision({ id: 'decision-c', slotId: null }),
  ];
  const slotById = new Map([
    ['slot-a', { project: 'example-audio-farm', machine: 'runner-local' }],
    ['slot-b', { project: 'farmslot-farm', machine: 'runner-local' }],
  ]);

  assert.deepEqual(
    filterDecisions(
      decisions,
      { projects: ['example-audio-farm'], machines: ['runner-local'] },
      slotById,
    ).map((decision) => decision.id),
    ['decision-a'],
  );
});

test('filterDecisions can use decision context when slot context is unavailable', () => {
  const decisions: PendingDecision[] = [
    makeDecision({
      id: 'decision-a',
      slotId: null,
      context: { project: 'example-audio-farm', machine: 'runner-local' },
    }),
    makeDecision({
      id: 'decision-b',
      slotId: null,
      context: { project: 'farmslot-farm', machine: 'runner-a' },
    }),
    makeDecision({ id: 'decision-c', slotId: null }),
  ];

  assert.deepEqual(
    filterDecisions(
      decisions,
      { projects: ['example-audio-farm'], machines: ['runner-local'] },
      new Map(),
    ).map((decision) => decision.id),
    ['decision-a'],
  );
});

test('filterDecisions applies machine filters from slot id when context is unavailable', () => {
  const decisions: PendingDecision[] = [
    makeDecision({ id: 'decision-a', slotId: 'runner-local-mobile-6' }),
    makeDecision({ id: 'decision-b', slotId: 'runner-a-mm-2' }),
    makeDecision({ id: 'decision-c', slotId: null }),
  ];

  assert.deepEqual(
    filterDecisions(decisions, { projects: [], machines: ['runner-local'] }, new Map()).map(
      (decision) => decision.id,
    ),
    ['decision-a'],
  );
});

test('loadPersistedFilters restores saved filters and reports no rewrite when unchanged', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm'],
      machines: [],
    }),
  });

  const loaded = await loadPersistedFilters(storage, sources);

  assert.deepEqual(loaded.filters, { projects: ['example-audio-farm'], machines: [] });
  assert.deepEqual(loaded.available, {
    projects: ['example-audio-farm', 'example-mobile-farm', 'farmslot-farm'],
    machines: ['runner-local'],
  });
  assert.equal(loaded.shouldPersistReconciled, false);
  assert.equal(storage.setCalls.length, 0);
});

test('loadPersistedFilters preserves saved filters while sources are temporarily empty', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm'],
      machines: ['runner-local'],
    }),
  });

  const loaded = await loadPersistedFilters(storage, []);

  assert.deepEqual(loaded.filters, {
    projects: ['example-audio-farm'],
    machines: ['runner-local'],
  });
  assert.equal(loaded.shouldPersistReconciled, false);
});

test('loadPersistedFilters reads available sources after async storage resolves', async () => {
  const storageReadGate: { release?: () => void } = {};
  let currentSources: FilterSource[] = [];
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm'],
      machines: ['runner-local'],
    }),
  });
  storage.beforeGetItemResolve = () =>
    new Promise<void>((resolve) => {
      storageReadGate.release = resolve;
    });

  const loading = loadPersistedFilters(storage, () => currentSources);
  currentSources = sources;
  storageReadGate.release?.();
  const loaded = await loading;

  assert.deepEqual(loaded.filters, {
    projects: ['example-audio-farm'],
    machines: ['runner-local'],
  });
  assert.deepEqual(loaded.available, {
    projects: ['example-audio-farm', 'farmslot-farm'],
    machines: ['runner-local'],
  });
});

test('loadPersistedFilters keeps saved filters absent from current sources without rewrite', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm', 'missing-project'],
      machines: ['missing-machine', 'runner-local'],
    }),
  });

  const loaded = await loadPersistedFilters(storage, sources);

  assert.deepEqual(loaded.filters, {
    projects: ['example-audio-farm', 'missing-project'],
    machines: ['missing-machine', 'runner-local'],
  });
  assert.equal(loaded.shouldPersistReconciled, false);
});

test('loadPersistedFilters resets malformed persisted filters for rewrite', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: '{"projects":["example-audio-farm"],',
  });

  const loaded = await loadPersistedFilters(storage, sources);

  assert.deepEqual(loaded.savedFilters, { projects: [], machines: [] });
  assert.deepEqual(loaded.filters, { projects: [], machines: [] });
  assert.deepEqual(loaded.available, {
    projects: ['example-audio-farm', 'example-mobile-farm', 'farmslot-farm'],
    machines: ['runner-a', 'runner-local'],
  });
  assert.equal(loaded.shouldPersistReconciled, true);
});

test('savePersistedFilters normalizes persisted filter order and values', async () => {
  const storage = new MemoryFilterStorage();

  await savePersistedFilters(storage, {
    projects: ['example-mobile-farm', '', 'example-audio-farm', 'example-audio-farm'],
    machines: ['runner-local', 'runner-a', 'runner-local'],
  });

  assert.deepEqual(JSON.parse(storage.items[GLOBAL_FILTERS_STORAGE_KEY]), {
    projects: ['example-audio-farm', 'example-mobile-farm'],
    machines: ['runner-a', 'runner-local'],
  });
});

test('filter store restores persisted filters with current source options', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm'],
      machines: ['runner-local'],
    }),
  });
  const store = createFilterStore(storage);

  store.getState().setAvailable(sources);
  await store.getState().init();

  assert.deepEqual(store.getState().filters, {
    projects: ['example-audio-farm'],
    machines: ['runner-local'],
  });
  assert.deepEqual(store.getState().availableProjects, ['example-audio-farm', 'farmslot-farm']);
  assert.deepEqual(store.getState().availableMachines, ['runner-local']);
});

test('filter store hydration does not overwrite user changes made while storage is loading', async () => {
  const storageReadGate: { release?: () => void } = {};
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm'],
      machines: [],
    }),
  });
  storage.beforeGetItemResolve = () =>
    new Promise<void>((resolve) => {
      storageReadGate.release = resolve;
    });
  const store = createFilterStore(storage);
  store.getState().setAvailable(sources);

  const init = store.getState().init();
  store.getState().toggleProject('farmslot-farm');
  storageReadGate.release?.();
  await init;

  assert.deepEqual(store.getState().filters, { projects: ['farmslot-farm'], machines: [] });
  assert.equal(store.getState().initialized, true);
  assert.equal(store.getState().initializing, false);
  assert.deepEqual(JSON.parse(storage.items[GLOBAL_FILTERS_STORAGE_KEY]), {
    projects: ['farmslot-farm'],
    machines: [],
  });
});

test('filter store init is idempotent after hydration', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm'],
      machines: [],
    }),
  });
  const store = createFilterStore(storage);
  store.getState().setAvailable(sources);
  await store.getState().init();
  store.getState().toggleProject('farmslot-farm');
  storage.items[GLOBAL_FILTERS_STORAGE_KEY] = JSON.stringify({
    projects: ['example-mobile-farm'],
    machines: [],
  });

  await store.getState().init();

  assert.deepEqual(store.getState().filters, {
    projects: ['example-audio-farm', 'farmslot-farm'],
    machines: [],
  });
});

test('filter store rewrites malformed persisted filters after hydration', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: '{"machines":["runner-local"]',
  });
  const store = createFilterStore(storage);
  store.getState().setAvailable(sources);

  await store.getState().init();

  assert.deepEqual(store.getState().filters, { projects: [], machines: [] });
  assert.deepEqual(JSON.parse(storage.items[GLOBAL_FILTERS_STORAGE_KEY]), {
    projects: [],
    machines: [],
  });
});

test('filter store does not delete persisted filters when available sources change', async () => {
  const storage = new MemoryFilterStorage({
    [GLOBAL_FILTERS_STORAGE_KEY]: JSON.stringify({
      projects: ['example-audio-farm'],
      machines: ['runner-local'],
    }),
  });
  const store = createFilterStore(storage);
  store.getState().setAvailable(sources);
  await store.getState().init();

  store.getState().setAvailable([{ project: 'example-mobile-farm', machine: 'runner-a' }]);

  assert.deepEqual(store.getState().filters, {
    projects: ['example-audio-farm'],
    machines: ['runner-local'],
  });
  assert.deepEqual(JSON.parse(storage.items[GLOBAL_FILTERS_STORAGE_KEY]), {
    projects: ['example-audio-farm'],
    machines: ['runner-local'],
  });
  assert.equal(storage.setCalls.length, 0);
});

function makeRun(overrides: Pick<Run, 'id' | 'project' | 'slotId'>): Run {
  return {
    id: overrides.id,
    familyId: `family-${overrides.id}`,
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: overrides.project,
    ticketOrPr: overrides.id,
    slotId: overrides.slotId,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
  };
}

function makeDecision(
  overrides: Pick<PendingDecision, 'id' | 'slotId'> & {
    context?: PendingDecision['context'];
  },
): PendingDecision {
  return {
    id: overrides.id,
    type: 'plan_confirmation',
    slotId: overrides.slotId,
    title: overrides.id,
    description: overrides.id,
    context: overrides.context ?? {},
    actions: [],
    createdAt: '2026-05-20T00:00:00.000Z',
  };
}

class MemoryFilterStorage {
  items: Record<string, string>;
  setCalls: Array<{ key: string; value: string }> = [];
  beforeGetItemResolve: (() => Promise<void>) | null = null;

  constructor(items: Record<string, string> = {}) {
    this.items = { ...items };
  }

  async getItem(key: string): Promise<string | null> {
    if (this.beforeGetItemResolve) await this.beforeGetItemResolve();
    return this.items[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.items[key] = value;
    this.setCalls.push({ key, value });
  }
}
