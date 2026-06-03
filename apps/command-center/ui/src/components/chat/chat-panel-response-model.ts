import type { ChatMessage, ChatResponsePayload } from '@farmslot/protocol';

export interface ChatPanelResponseState {
  messages: readonly ChatMessage[];
  streamingText: string;
  streamingStatus: string;
  streamingError: string;
  sending: boolean;
  sessionCost: number;
  usageOpen: boolean;
}

export interface ChatPanelResponseUpdate extends ChatPanelResponseState {
  ignored: boolean;
  shouldLoadUsageContext: boolean;
  shouldLoadSessions: boolean;
  shouldScrollToBottom: boolean;
}

export function applyChatPanelResponse(
  state: ChatPanelResponseState,
  payload: ChatResponsePayload,
  activeSessionId: string,
): ChatPanelResponseUpdate {
  if (payload.sessionId !== activeSessionId) {
    return {
      ...state,
      ignored: true,
      shouldLoadUsageContext: false,
      shouldLoadSessions: false,
      shouldScrollToBottom: false,
    };
  }

  if (payload.state === 'delta') {
    const statusAfterPayload = payload.statusText || state.streamingStatus;
    const hasText = Boolean(payload.text);
    const shouldUseStreamingStatus =
      hasText &&
      (!statusAfterPayload ||
        statusAfterPayload === 'Working…' ||
        statusAfterPayload === 'Streaming answer...');
    return {
      ...state,
      streamingStatus: shouldUseStreamingStatus ? 'Streaming answer...' : statusAfterPayload,
      streamingText: hasText ? `${state.streamingText}${payload.text}` : state.streamingText,
      ignored: false,
      shouldLoadUsageContext: false,
      shouldLoadSessions: false,
      shouldScrollToBottom: false,
    };
  }

  if (payload.state === 'final') {
    const messages = payload.message ? [...state.messages, payload.message] : state.messages;
    const cost = payload.message?.usage?.costUsd
      ? state.sessionCost + payload.message.usage.costUsd
      : state.sessionCost;
    return {
      ...state,
      messages,
      streamingText: '',
      streamingStatus: '',
      streamingError: '',
      sending: false,
      sessionCost: cost,
      ignored: false,
      shouldLoadUsageContext: Boolean(payload.message && state.usageOpen),
      shouldLoadSessions: Boolean(payload.message),
      shouldScrollToBottom: true,
    };
  }

  if (payload.state === 'aborted') {
    return {
      ...state,
      streamingText: '',
      streamingStatus: '',
      streamingError: '',
      sending: false,
      ignored: false,
      shouldLoadUsageContext: false,
      shouldLoadSessions: false,
      shouldScrollToBottom: false,
    };
  }

  return {
    ...state,
    streamingText: '',
    streamingStatus: 'Error.',
    streamingError: payload.errorMessage ?? 'Co-Pilot response failed.',
    sending: false,
    ignored: false,
    shouldLoadUsageContext: false,
    shouldLoadSessions: false,
    shouldScrollToBottom: false,
  };
}
