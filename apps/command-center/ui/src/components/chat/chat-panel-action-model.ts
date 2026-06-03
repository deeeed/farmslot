import type { ChatMessage } from '@farmslot/protocol';

export interface ChatActionPruneResult {
  messages: ChatMessage[];
  pruned: number;
}

export function collectChatActionIds(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!message.suggestedActions) continue;
    for (const action of message.suggestedActions) {
      if (action.actionId) ids.add(action.actionId);
    }
  }
  return ids;
}

export function pruneStaleChatActions(
  messages: readonly ChatMessage[],
  liveActionIds: ReadonlySet<string>,
): ChatActionPruneResult {
  let pruned = 0;
  const next: ChatMessage[] = [];

  for (const message of messages) {
    if (!message.suggestedActions) {
      next.push(message);
      continue;
    }

    const survivors = message.suggestedActions.filter((action) => {
      // Legacy action with no id — leave for the card's own unavailable rendering.
      if (!action.actionId) return true;
      if (liveActionIds.has(action.actionId)) return true;
      pruned += 1;
      return false;
    });

    if (survivors.length === message.suggestedActions.length) {
      next.push(message);
    } else {
      next.push({ ...message, suggestedActions: survivors });
    }
  }

  return { messages: next, pruned };
}
