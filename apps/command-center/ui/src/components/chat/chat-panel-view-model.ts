import type { ChatSessionSummary } from '@farmslot/protocol';

import { SHARED_SESSION_ID } from './chat-panel-model.js';

export interface ChatPanelViewModelInput {
  sending: boolean;
  streamingText: string;
  streamingError: string;
  activeSessionId: string;
  sessionSummaries: readonly ChatSessionSummary[];
}

export interface ChatPanelViewModel {
  isStreaming: boolean;
  activeSummary: ChatSessionSummary | undefined;
  activePinned: boolean;
  canPin: boolean;
  historySessions: ChatSessionSummary[];
  historyCount: number;
}

export function chatPanelViewModel(input: ChatPanelViewModelInput): ChatPanelViewModel {
  const activeSummary = input.sessionSummaries.find(
    (session) => session.id === input.activeSessionId,
  );
  const activePinned = activeSummary
    ? activeSummary.pinned !== false
    : input.activeSessionId === SHARED_SESSION_ID;
  const canPin = input.activeSessionId !== SHARED_SESSION_ID && !activePinned;
  const historySessions = input.sessionSummaries.filter(
    (session) => session.id !== SHARED_SESSION_ID,
  );
  return {
    isStreaming: input.sending || Boolean(input.streamingText) || Boolean(input.streamingError),
    activeSummary,
    activePinned,
    canPin,
    historySessions,
    historyCount: historySessions.length,
  };
}
