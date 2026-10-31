/** Terminal text a reader added to a native conversation that has not opened yet, by attempt key. */
const pending = new Map<string, string>();

/**
 * A terminal selection as conversation context: a fenced block without the terminal's padding
 * (trailing spaces, blank lines at either end). The fence is longer than any backtick run inside.
 */
export function terminalChatContext(selection: string): string {
  const lines = selection
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!lines.length) return '';
  const longest = Math.max(0, ...[...selection.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${lines.join('\n')}\n${fence}`;
}

/** Keeps context for the conversation with this attempt key until it opens. */
export function queueNativeChatContext(attemptKey: string, context: string) {
  pending.set(attemptKey, [pending.get(attemptKey), context].filter(Boolean).join('\n\n'));
}

/** The context waiting for this conversation, once. */
export function takeNativeChatContext(attemptKey: string): string | undefined {
  const context = pending.get(attemptKey);
  pending.delete(attemptKey);
  return context;
}

/** A draft with context added after what the reader already typed. */
export function draftWithContext(draft: string, context: string): string {
  return [draft.trimEnd(), context].filter(Boolean).join('\n\n');
}
