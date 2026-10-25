import { Methods, type SlotAgentTargetParams, type TerminalSendParams } from '@farmslot/protocol';
import type { OperatorMessageInput } from '@farmslot/review-dispatch';

export interface TerminalTextRequest {
  method: typeof Methods.TERMINAL_SEND;
  params: TerminalSendParams;
}

/** Text submissions use guarded semantic delivery; target pins survive a retry. */
export function terminalTextRequest(
  target: SlotAgentTargetParams,
  message: OperatorMessageInput,
): TerminalTextRequest {
  return { method: Methods.TERMINAL_SEND, params: { ...target, ...message } };
}
