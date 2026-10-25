import type { TerminalSendParams } from '@farmslot/protocol';

export type OperatorMessageInput = Required<
  Pick<TerminalSendParams, 'operatorMessageId' | 'text' | 'enter'>
>;

/** Keep this object for a transport retry. The ID is correlation, never authority. */
export function operatorMessageInput(
  text: string,
  operatorMessageId = `message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
): OperatorMessageInput {
  return { text, operatorMessageId, enter: true };
}
