/** The key a terminal reads as Backspace. */
export const TERMINAL_BACKSPACE = '\x7f';

/**
 * What to send so the pane's line matches `next`, given it already has `previous`: one Backspace
 * per character removed after their shared start, then the new characters. Counts code points, so
 * an emoji is one Backspace, as the shell sees it.
 */
export function inputLineDelta(previous: string, next: string): string {
  const before = Array.from(previous);
  const after = Array.from(next);
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared])
    shared += 1;
  return TERMINAL_BACKSPACE.repeat(before.length - shared) + after.slice(shared).join('');
}
