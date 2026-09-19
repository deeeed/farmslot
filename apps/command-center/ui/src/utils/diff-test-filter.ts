// Diff-view test filter: the shared "hide tests" preference and the split of
// a changed-file list into visible files plus a code/test summary. Kinds come
// from the gateway when stamped; otherwise the given (or default) matcher
// classifies the path.

import {
  classifyDiffFile,
  type DiffFileKind,
  type DiffKindSummary,
  summarizeDiffKinds,
  type TestFileMatcher,
} from '@farmslot/protocol';

import { safeLsGet, safeLsSet } from './storage.js';

export const HIDE_TESTS_PREF_KEY = 'farmslot.diffView.hideTests';

// One in-memory value for the page, so every mounted list flips together;
// localStorage only carries it across reloads.
let hideTests = safeLsGet(HIDE_TESTS_PREF_KEY) === '1';
const listeners = new Set<(hide: boolean) => void>();

export function readHideTestsPref(): boolean {
  return hideTests;
}

export function writeHideTestsPref(hide: boolean): void {
  if (hide === hideTests) return;
  hideTests = hide;
  safeLsSet(HIDE_TESTS_PREF_KEY, hide ? '1' : '0');
  for (const listener of listeners) listener(hide);
}

/** Subscribe to preference changes; returns the unsubscribe function. */
export function subscribeHideTestsPref(listener: (hide: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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

export interface SplitDiffFilesOptions {
  /** Path that stays visible even when hidden (the file open in the viewer). */
  keepPath?: string;
  /** Classifier for files without a stamped kind; defaults to the built-in patterns. */
  matcher?: TestFileMatcher;
}

export function splitDiffFilesByKind<
  T extends { path: string; additions: number; deletions: number; kind?: DiffFileKind },
>(files: readonly T[], hide: boolean, options: SplitDiffFilesOptions = {}): DiffKindSplit<T> {
  const kindOf = (file: T) => file.kind ?? classifyDiffFile(file.path, options.matcher);
  const summary = summarizeDiffKinds(files, options.matcher);
  const visible = hide
    ? files.filter((file) => file.path === options.keepPath || kindOf(file) !== 'test')
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

/** Short ratio label, e.g. `3 test files · 41% of lines`; null when no test files. */
export function formatTestShare(summary: DiffKindSummary): string | null {
  if (summary.testFiles === 0) return null;
  const files = `${summary.testFiles} test file${summary.testFiles === 1 ? '' : 's'}`;
  if (summary.testShare === null) return files;
  return `${files} · ${Math.round(summary.testShare * 100)}% of lines`;
}
