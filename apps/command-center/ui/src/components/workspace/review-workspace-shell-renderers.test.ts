import assert from 'node:assert/strict';
import test from 'node:test';

import type { GitBranchDiffFile } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

import {
  renderReviewDiffFiles,
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
