import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionCatalogResult } from '@farmslot/protocol';

import { catalogForNativeRunners } from '../src/catalog.js';
import {
  nativeLaunchChoices,
  nativeLaunchModel,
  nativeLaunchModelSelection,
} from '../src/native-launch.js';
import { ReviewDispatchViewModel } from '../src/view-model.js';

const catalog: NativeSessionCatalogResult = {
  runners: [],
  executionNodes: [
    { executionNodeId: 'macwork', label: 'macwork', homeDirectory: '/Users/person' },
    { executionNodeId: 'mini', label: 'mini', homeDirectory: '/Volumes/Data/operator' },
    {
      executionNodeId: 'macpro',
      label: 'macpro',
      homeDirectory: '/Users/farm',
      unavailableReason: 'Refresh native host',
    },
  ],
  contexts: [
    {
      label: 'one',
      slotId: 'one',
      project: 'terminal',
      cwd: '/a/terminal',
      executionNodeId: 'macwork',
    },
    { label: 'two', slotId: 'two', project: 'mobile', cwd: '/b/mobile', executionNodeId: 'mini' },
    {
      label: 'three',
      slotId: 'three',
      project: 'terminal',
      cwd: '/c/terminal',
      executionNodeId: 'macpro',
    },
  ],
};

test('workspaces follow project and machine chips; custom directories follow machines', () => {
  const choices = nativeLaunchChoices(catalog, {
    projects: ['terminal'],
    machines: ['macwork', 'macpro'],
  });
  assert.deepEqual(
    choices.filter((choice) => choice.kind === 'workspace').map((choice) => choice.slotId),
    ['three', 'one'],
  );
  assert.deepEqual(
    choices.filter((choice) => choice.kind === 'custom').map((choice) => choice.executionNodeId),
    ['macpro', 'macwork'],
  );
  assert.equal(choices[0].unavailableReason, 'Refresh native host');
});

test('custom directories use actual target homes and retain unavailable reasons', () => {
  const choices = nativeLaunchChoices(catalog, { projects: [], machines: [] });
  assert.equal(
    choices.find((choice) => choice.key === 'custom:mini')?.cwd,
    '/Volumes/Data/operator',
  );
  assert.equal(
    choices.find((choice) => choice.key === 'custom:macpro')?.unavailableReason,
    'Refresh native host',
  );
  assert.equal(choices.find((choice) => choice.key === 'custom:macwork')?.unavailableReason, null);
});

test('fleet machines without native catalog metadata are not offered as launch targets', () => {
  const choices = nativeLaunchChoices(
    { runners: [], contexts: [] },
    { projects: [], machines: [] },
    [{ slot: 'slot', machine: 'farmslot-demo', project: 'mobile' }],
  );
  assert.deepEqual(choices, []);
});

test('workspace contexts remain launchable when optional custom-target metadata is absent', () => {
  const choices = nativeLaunchChoices(
    { runners: [], contexts: [{ label: 'Workspace', cwd: '/workspace', executionNodeId: 'mini' }] },
    { projects: [], machines: [] },
  );
  assert.equal(choices.find((choice) => choice.kind === 'workspace')?.unavailableReason, null);
  assert.match(
    choices.find((choice) => choice.kind === 'custom')?.unavailableReason ?? '',
    /metadata unavailable/,
  );
});

test('custom model selections follow the shared catalog permission', () => {
  const runner = {
    id: 'codex',
    models: [{ id: 'listed' }],
    defaultModel: 'listed',
    efforts: [],
    defaultEffort: null,
    allowCustomModels: true,
  };
  assert.equal(nativeLaunchModel(runner, 'custom-provider-model'), 'custom-provider-model');
  assert.equal(
    nativeLaunchModel({ ...runner, allowCustomModels: false }, 'custom-provider-model'),
    'listed',
  );
});

test('changing effort keeps the default sentinel and follows a refreshed runner default', () => {
  const runner = {
    id: 'codex',
    models: [{ id: 'first' }, { id: 'second' }],
    defaultModel: 'first',
    efforts: ['high'],
    defaultEffort: null,
    allowCustomModels: true,
  };
  const picker = new ReviewDispatchViewModel({
    context: { allowedActions: ['chat'] },
    catalog: { runners: [runner] },
    sequence: [
      {
        runner: 'codex',
        model: nativeLaunchModelSelection(runner, ''),
        effort: null,
        mode: 'cold',
      },
    ],
  });
  picker.setEffort(picker.rows[0].id, 'high');
  assert.equal(picker.selection?.model, null);
  assert.equal(
    nativeLaunchModel({ ...runner, defaultModel: 'second' }, picker.selection?.model),
    'second',
  );
});

test('changing execution nodes drops unlisted models while current-node custom ids remain allowed', () => {
  const target = {
    id: 'pi',
    models: [{ id: 'provider/b' }],
    defaultModel: 'provider/b',
    efforts: [],
    defaultEffort: null,
    allowCustomModels: true,
  };
  assert.equal(nativeLaunchModelSelection(target, 'provider/a', true), null);
  assert.equal(nativeLaunchModelSelection(target, 'provider/b', true), 'provider/b');
  assert.equal(
    nativeLaunchModelSelection(target, 'custom-provider-model'),
    'custom-provider-model',
  );
});

test('native catalog carries registered agent effort choices to the shared model picker', () => {
  const result = catalogForNativeRunners([
    {
      runner: 'claude-acp',
      models: ['haiku'],
      defaultModel: 'haiku',
      modes: ['default', 'plan'],
      efforts: ['low', 'high'],
      defaultEffort: 'low',
    },
  ]);
  assert.deepEqual(result.runners[0].efforts, ['low', 'high']);
  assert.equal(result.runners[0].defaultEffort, 'low');
});
