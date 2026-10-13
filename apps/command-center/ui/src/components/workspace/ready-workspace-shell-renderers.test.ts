import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_ATTESTATION_ACTION,
  type GitBranchDiffFile,
  type ReadyGatePayload,
  type RunDecision,
} from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

import {
  renderReadyDiffTab,
  renderReadyTabBar,
  renderReadyTopBar,
} from './ready-workspace-shell-renderers.js';

test('the existing top bar shows the shared attestation reason and explicit confirmation', () => {
  const rendered = renderReadyTopBar({
    payload: {
      kind: 'ready',
      branch: 'branch',
      diffStat: { files: 0, additions: 0, deletions: 0 },
      reviews: [],
      prPackage: {},
    } as unknown as ReadyGatePayload,
    decision: { actions: [EVIDENCE_ATTESTATION_ACTION] } as RunDecision,
    publicationTarget: 'draft',
    pendingConfirm: EVIDENCE_ATTESTATION_ACTION.id,
    attestationReason: 'Inspected retained evidence.',
    acting: false,
    recovering: false,
    fileDiffAvailable: false,
    actionMessage: '',
    actionTone: '',
    openDiff: () => undefined,
    openReviewRequestModal: () => undefined,
    confirmAction: () => undefined,
  });
  const text = litText(rendered);
  assert.match(text, /Reason for evidence policy attestation/);
  assert.match(text, /Confirm attestation and publish/);
  assert.match(text, /Integrity, source, CI and review checks remain required/);
});

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
