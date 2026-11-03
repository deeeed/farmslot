import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionCatalogResult } from '@farmslot/protocol';

import { nativeLaunchChoices, nativeLaunchModel } from '../src/native-launch.js';

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

test('known machines with missing metadata remain visible and disabled without guessed homes', () => {
  const choices = nativeLaunchChoices(
    { runners: [], contexts: [] },
    { projects: [], machines: [] },
    [{ slot: 'slot', machine: 'mini', project: 'mobile' }],
  );
  assert.equal(choices.length, 1);
  assert.equal(choices[0].key, 'custom:mini');
  assert.equal(choices[0].cwd, '');
  assert.match(choices[0].unavailableReason ?? '', /metadata unavailable/);
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
