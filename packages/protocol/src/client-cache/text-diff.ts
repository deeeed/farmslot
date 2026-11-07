import { createTwoFilesPatch } from 'diff';

import type { NativeToolDiff } from '../rpc/native-session.js';

/** One formatter for decision previews and native tool edits on both clients. */
export function createTextDiff(
  beforePath: string,
  afterPath: string,
  before: string,
  after: string,
): string {
  return createTwoFilesPatch(beforePath, afterPath, before, after, '', '', { context: 3 });
}

const toolDiffText = new WeakMap<NativeToolDiff, string>();

/** Formatting is demand-driven by the open tool detail, never by incoming text deltas. */
export function nativeToolDiffText(diff: NativeToolDiff): string {
  let text = toolDiffText.get(diff);
  if (text === undefined) {
    text =
      `diff --git a/${diff.path} b/${diff.path}\n` +
      createTextDiff(
        diff.oldText === null ? '/dev/null' : diff.path,
        diff.path,
        diff.oldText ?? '',
        diff.newText,
      );
    toolDiffText.set(diff, text);
  }
  return text;
}
