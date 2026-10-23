import assert from 'node:assert/strict';
import test from 'node:test';

import type { GitBranchDiffFile, Run } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

import {
  renderReviewDiffFiles,
  renderReviewTopBar,
  reviewSeverityColor,
  reviewSeverityCounts,
} from './review-workspace-shell-renderers.js';

test('reviewSeverityCounts preserves severity buckets for top bar badges', () => {
  assert.deepEqual(
    reviewSeverityCounts([
      { severity: 'must_fix' },
      { severity: 'suggestion' },
      { severity: 'must_fix' },
      { severity: 'nitpick' },
    ]),
    { must_fix: 2, suggestion: 1, nitpick: 1 },
  );
});

test('reviewSeverityColor falls back for unknown severities', () => {
  assert.equal(reviewSeverityColor('must_fix'), '#ef4444');
  assert.equal(reviewSeverityColor('custom'), '#6b7280');
});

const codeFile: GitBranchDiffFile = {
  path: 'src/gate.ts',
  status: 'M',
  additions: 4,
  deletions: 1,
};
const testFile: GitBranchDiffFile = {
  path: 'src/gate.test.ts',
  status: 'M',
  additions: 9,
  deletions: 0,
};

function diffFilesText(
  files: GitBranchDiffFile[],
  hideTests: boolean,
  selectedFile: string,
  findingOpen = false,
): string {
  const testFilter = new DiffTestFilterController(new FakeControllerHost());
  testFilter.hideTests = hideTests;
  return litText(
    renderReviewDiffFiles({
      files,
      testFilter,
      selectedFile,
      findingOpen,
      commentCounts: new Map(),
      recovering: false,
      selectFile: () => undefined,
      renderCodePanel: () => `CODE:${selectedFile}`,
    }),
  ).replace(/\s+/g, ' ');
}

test('renderReviewDiffFiles lists the visible files with the shared toggle and count', () => {
  const shown = diffFilesText([codeFile, testFile], false, codeFile.path);
  assert.match(shown, /2 files/);
  assert.match(shown, /Hide tests/);
  assert.match(shown, /gate\.test\.ts/);

  const hidden = diffFilesText([codeFile, testFile], true, codeFile.path);
  assert.match(hidden, /1 of 2 files/);
  assert.match(hidden, /Show tests \(1\)/);
  assert.doesNotMatch(hidden, /gate\.test\.ts/);
  assert.match(hidden, /CODE:src\/gate\.ts/);
});

test('renderReviewDiffFiles shows the all-hidden state even with a test file still selected', () => {
  const text = diffFilesText([testFile], true, testFile.path);
  assert.match(text, /0 of 1 files/);
  assert.match(text, /Only test files changed/);
  assert.doesNotMatch(text, /CODE:/);
  assert.match(
    diffFilesText([testFile], true, testFile.path, true),
    /CODE:src\/gate\.test\.ts/,
    'an open finding keeps its code visible',
  );
});

function reviewInput(
  overrides: Partial<Parameters<typeof renderReviewTopBar>[0]> = {},
): Parameters<typeof renderReviewTopBar>[0] {
  return {
    comments: [],
    includedComments: 0,
    selectedRecommendation: 'COMMENT',
    setRecommendation: () => undefined,
    hasLearnings: false,
    evidenceCount: 0,
    includeEvidence: false,
    setIncludeEvidence: () => undefined,
    posting: false,
    postAvailable: false,
    recovering: false,
    refreshing: false,
    proposing: false,
    proposeError: null,
    pendingConfirm: null,
    refresh: () => undefined,
    proposeImprovement: () => undefined,
    post: () => undefined,
    dismiss: () => undefined,
    ...overrides,
  };
}

test('a refreshed gate without Post renders no publication control', () => {
  const input = reviewInput();
  assert.doesNotMatch(litText(renderReviewTopBar(input)), /Post to PR/);
  assert.match(litText(renderReviewTopBar({ ...input, postAvailable: true })), /Post to PR/);
});

test('every review workspace derives Ask reviewer from its run without parent link wiring', () => {
  const run: Run = {
    id: 'review-run',
    familyId: 'review-run',
    flowType: 'review-pr',
    lane: 'production',
    status: 'human-gating',
    project: 'fixture',
    ticketOrPr: 'example/repo#1',
    slotId: 'review-slot',
    branch: 'feature',
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    agentContexts: [
      {
        id: 'retained-reviewer',
        runId: 'review-run',
        slotId: 'review-slot',
        label: 'Reviewer',
        role: 'review',
        status: 'waiting',
        target: { session: 'review', window: 'review', target: 'review:review.0' },
      },
    ],
  };
  assert.match(
    litText(renderReviewTopBar(reviewInput({ run }))),
    /href=#slot\/review-slot\?runId=review-run&contextId=retained-reviewer/,
  );
  const context = run.agentContexts?.[0];
  assert(context);
  const nativeRun: Run = {
    ...run,
    slotId: null,
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: '/fixture/source',
      taskPath: '/fixture/task',
      artifactPath: '/fixture/task/artifacts',
    },
    agentContexts: [
      {
        ...context,
        slotId: null,
        target: null,
        nativeSession: {
          sessionId: 'native-review',
          executionNodeId: 'review-node',
          ownerPrincipalId: 'person',
          generation: 'generation',
          leaseId: 'lease',
          commandId: 'original',
          acceptedAt: '2026-10-23T00:00:00Z',
        },
      },
    ],
  };
  assert.match(
    litText(renderReviewTopBar(reviewInput({ run: nativeRun }))),
    /href=#terminal\?run=review-run&contextId=retained-reviewer/,
  );
});
