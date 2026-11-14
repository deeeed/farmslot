import { createTwoFilesPatch, formatPatch, parsePatch } from 'diff';

import type { EvalBenchDiffFile } from '../contracts/eval-bench.js';

export function benchDiffFiles(patch: string): EvalBenchDiffFile[] {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    throw new Error('Retained unified patch cannot be parsed');
  }
  return parsed.map((file) => {
    const name =
      (file.newFileName === '/dev/null' ? file.oldFileName : file.newFileName) ??
      file.index ??
      'Unknown file';
    const filePath = name.replace(/^[ab]\//, '');
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    const test =
      /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+$/.test(
        filePath,
      );
    return {
      path: filePath,
      additions: lines.filter((line) => line.startsWith('+')).length,
      deletions: lines.filter((line) => line.startsWith('-')).length,
      text: formatPatch(file),
      kind: test ? 'test' : /\.(md|txt|json|ya?ml|lock)$/.test(filePath) ? 'other' : 'code',
    };
  });
}

/** Callback mode yields between edit lengths. All calls share their caller's deadline. */
export function createBenchPatchDiff(
  beforeName: string,
  afterName: string,
  before: string,
  after: string,
  remainingMs: number,
): Promise<string | null> {
  if (remainingMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    createTwoFilesPatch(beforeName, afterName, before, after, undefined, undefined, {
      timeout: remainingMs,
      maxEditLength: 1024,
      callback: (patch) => resolve(patch ?? null),
    });
  });
}
