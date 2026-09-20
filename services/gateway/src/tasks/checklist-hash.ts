// One checkbox-state fingerprint for every progress observer.
//
// Both observers need the same question answered — "did any box change since the
// last read?" — before they spend a broadcast on it: the slot task watcher
// (`tasks/watcher.ts`) and the review-workspace progress publisher
// (`review-workspaces/progress.ts`). They are deliberately NOT using the shared
// `enumerateChecklistCheckboxes` parser: this is a cheap change detector over raw
// lines, not a schema read, and it must stay stable for both callers rather than
// follow the enumerator's rules about which rows count as steps.

/** Checked/unchecked state of every checkbox line, concatenated in file order. */
export function hashChecklistCheckboxes(markdown: string): string {
  let hash = '';
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) hash += '1';
    else if (trimmed.startsWith('- [ ]')) hash += '0';
  }
  return hash;
}
