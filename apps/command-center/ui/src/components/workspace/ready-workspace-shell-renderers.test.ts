import assert from 'node:assert/strict';
import test from 'node:test';

import type { GitBranchDiffFile, ReadyGatePayload } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

import { renderReadyDiffTab, renderReadyTabBar } from './ready-workspace-shell-renderers.js';

const files: GitBranchDiffFile[] = [
  { path: 'src/gate.ts', status: 'M', additions: 4, deletions: 1 },
  { path: 'src/gate.test.ts', status: 'M', additions: 9, deletions: 0 },
  { path: 'src/panel.ts', status: 'A', additions: 12, deletions: 0 },
];

function tabBarText(diffCount: string): string {
  return litText(
    renderReadyTabBar({
      payload: {} as ReadyGatePayload,
      activeTab: 'diff',
      hideRecipeTab: false,
      evidenceCount: 0,
      qualityCount: 0,
      inputCount: 0,
      diffCount,
      setActiveTab: () => undefined,
    }),
  ).replace(/\s+/g, ' ');
}

function diffTabText(hideTests: boolean, source = files): string {
  const testFilter = new DiffTestFilterController(new FakeControllerHost());
  testFilter.hideTests = hideTests;
  return litText(
    renderReadyDiffTab({
      slotId: 'slot-1',
      diffLoading: false,
      diffError: '',
      diffFiles: source,
      testFilter,
      selectedFile: testFilter.split(source).visible[0]?.path ?? '',
      recovering: false,
      fileDiffLoading: false,
      fileDiff: '',
      selectFile: () => undefined,
    }),
  ).replace(/\s+/g, ' ');
}

test('renderReadyTabBar shows the filtered Diff count only while files are hidden', () => {
  assert.match(tabBarText('12'), /Diff \(12\)/);
  assert.match(tabBarText('5 of 12'), /Diff \(5 of 12\)/);
});

test('renderReadyDiffTab drops test pills and offers to show them when hiding', () => {
  const shown = diffTabText(false);
  assert.match(shown, /gate\.test\.ts/);
  assert.match(shown, /Hide tests/);

  const hidden = diffTabText(true);
  assert.doesNotMatch(hidden, /gate\.test\.ts/);
  assert.match(hidden, /gate\.ts/);
  assert.match(hidden, /panel\.ts/);
  assert.match(hidden, /Show tests \(1\)/);
});

test('renderReadyDiffTab keeps the toggle reachable when every changed file is a test', () => {
  const text = diffTabText(true, [files[1]]);
  assert.match(text, /Show tests \(1\)/);
  assert.match(text, /Only test files changed/);
  assert.doesNotMatch(text, /No changed files/);
});
