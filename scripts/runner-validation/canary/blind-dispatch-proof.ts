import type {
  WorkerSessionHistoryMessage,
  WorkerSessionHistorySnapshot,
} from '../../../packages/protocol/src/index.js';

/** Pane output and unavailable history cannot prove a model tool call. */
export function firstBlindTool(
  history: Pick<WorkerSessionHistorySnapshot, 'source' | 'messages'>,
): WorkerSessionHistoryMessage | undefined {
  return history.source === 'transcript'
    ? history.messages.find(
        (message) =>
          message.role === 'assistant' && message.tools?.some((tool) => tool.name.trim()),
      )
    : undefined;
}
