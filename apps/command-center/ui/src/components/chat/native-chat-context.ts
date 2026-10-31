import { markdownFence } from '@farmslot/protocol';
import { nativeTailLines, terminalLinesFromText } from '@farmslot/protocol/client-cache';

/** Terminal text a reader added to a native conversation that has not opened yet, by attempt key. */
const pending = new Map<string, string>();

/** The most of a selection a message carries; earlier lines are counted, not sent. */
export const TERMINAL_CHAT_CONTEXT_LINES = 400;

/**
 * A terminal selection as conversation context: a fenced block without the terminal's padding
 * (trailing spaces, blank lines at either end), keeping its last lines when it is long.
 */
export function terminalChatContext(selection: string): string {
  const lines = terminalLinesFromText(selection).map((line) => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!lines.length) return '';
  return markdownFence(nativeTailLines(lines, TERMINAL_CHAT_CONTEXT_LINES).join('\n'));
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
