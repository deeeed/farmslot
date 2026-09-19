// Diff-view test filter: the persisted "hide tests" preference and the split
// of a changed-file list into visible files plus a code/test summary. Kinds
// come from the gateway when stamped; otherwise the default patterns apply.

import {
  classifyDiffFile,
  type DiffFileKind,
  type DiffKindSummary,
  summarizeDiffKinds,
} from '@farmslot/protocol';

import { safeLsGet, safeLsSet } from './storage.js';

export const HIDE_TESTS_PREF_KEY = 'farmslot.diffView.hideTests';

export function readHideTestsPref(): boolean {
  return safeLsGet(HIDE_TESTS_PREF_KEY) === '1';
}

export function writeHideTestsPref(hide: boolean): void {
  safeLsSet(HIDE_TESTS_PREF_KEY, hide ? '1' : '0');
}

export interface DiffKindSplit<T> {
  visible: T[];
  summary: DiffKindSummary;
  hiddenCount: number;
  /** Additions across the visible files. */
  visibleAdditions: number;
  /** Deletions across the visible files. */
  visibleDeletions: number;
}

export function splitDiffFilesByKind<
  T extends { path: string; additions: number; deletions: number; kind?: DiffFileKind },
>(files: readonly T[], hideTests: boolean): DiffKindSplit<T> {
  const summary = summarizeDiffKinds(files);
  const visible = hideTests
    ? files.filter((file) => (file.kind ?? classifyDiffFile(file.path)) !== 'test')
    : [...files];
  let visibleAdditions = 0;
  let visibleDeletions = 0;
  for (const file of visible) {
    visibleAdditions += file.additions;
    visibleDeletions += file.deletions;
  }
  return {
    visible,
    summary,
    hiddenCount: files.length - visible.length,
    visibleAdditions,
    visibleDeletions,
  };
}

/** Short ratio label, e.g. `3 tests · 41% of lines`; null when no test files. */
export function formatTestShare(summary: DiffKindSummary): string | null {
  if (summary.testFiles === 0) return null;
  const files = `${summary.testFiles} test file${summary.testFiles === 1 ? '' : 's'}`;
  if (summary.testShare === null) return files;
  return `${files} · ${Math.round(summary.testShare * 100)}% of lines`;
}
