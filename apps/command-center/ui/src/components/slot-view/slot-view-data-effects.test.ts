import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { TaskProgressStructured } from '@farmslot/protocol';

// The progress applicator does not fetch configuration, fleet or URL state.
mock.module('../../configuration-resources.js', {
  namedExports: {
    readConfiguration() {
      throw new Error('Unexpected configuration read');
    },
  },
});
mock.module('../../state.js', {
  namedExports: {
    getState() {
      throw new Error('Unexpected fleet read');
    },
  },
});
mock.module('./slot-view-linked-run-model.js', {
  namedExports: { isSlotViewContextPinUnresolved: () => false },
});
mock.module('./slot-view-url-state.js', {
  namedExports: { getSlotViewHashParam: () => null, requestedRunFromHash: () => null },
});
const { applySlotViewTaskProgress } = await import('./slot-view-data-effects.js');

type ProgressView = Parameters<typeof applySlotViewTaskProgress>[0];

function fixture() {
  const step = { index: 1, name: 'Inspect', status: 'pending' as const };
  const source: TaskProgressStructured = {
    schema: {
      flowType: 'dev',
      title: 'Task',
      totalSteps: 1,
      phases: [{ name: 'Work', steps: [step] }],
    },
    phases: [{ name: 'Work', steps: [step], completedSteps: 0, totalSteps: 1 }],
    completedSteps: 0,
    totalSteps: 1,
    currentPhase: 'Work',
    currentStep: 'Inspect',
  };
  let reloads = 0;
  const query = {
    belongsToWorkspace: true,
    ready: true,
    state: {
      status: 'ready' as const,
      data: {
        slotId: 'slot',
        markdown: '- [ ] Inspect\n  Read actual source.\n',
        structured: source,
      },
    },
  };
  const view: ProgressView = {
    _progressQuery: query,
    _taskSteps: [],
    _taskProgress: 0,
    _pinnedFolder: 'task',
    _loadPinnedEntries: async () => {
      reloads += 1;
    },
  };
  return { view, source, query, reloads: () => reloads };
}

test('same progress observation preserves the pinned tree; a new one reloads it', () => {
  const f = fixture();
  applySlotViewTaskProgress(f.view);
  assert.equal(f.reloads(), 1);
  assert.equal(f.view._structuredProgress?.phases[0].steps[0].detail, 'Read actual source.');
  assert.notEqual(f.view._structuredProgress, f.source);
  assert.equal(f.source.phases[0].steps[0].detail, undefined);
  applySlotViewTaskProgress(f.view);
  assert.equal(f.reloads(), 1, 'enrichment must not make the same source appear new');
  const data = f.view._progressQuery.state.data;
  assert.ok(data);
  f.query.state = { status: 'ready', data: { ...data, structured: { ...f.source } } };
  applySlotViewTaskProgress(f.view);
  assert.equal(f.reloads(), 2);
});

test('clearing a workspace also clears progress identity before rehydration', () => {
  const f = fixture();
  applySlotViewTaskProgress(f.view);
  f.query.belongsToWorkspace = false;
  applySlotViewTaskProgress(f.view);
  assert.equal(f.view._structuredProgress, undefined);
  assert.equal(f.view._taskProgressSource, undefined);
  f.query.belongsToWorkspace = true;
  applySlotViewTaskProgress(f.view);
  assert.equal(f.reloads(), 2);
});
