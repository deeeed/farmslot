export type SlotViewKeyboardAction =
  | { kind: 'none' }
  | { kind: 'toggle-sidebar' }
  | { kind: 'toggle-resource-panel' }
  | { kind: 'save-file' }
  | { kind: 'switch-relative-slot'; direction: -1 | 1 }
  | { kind: 'close-new-file-prompt' };

export interface SlotViewKeyboardDecisionInput {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  inTerminal: boolean;
  inEditable: boolean;
  hasSlotId: boolean;
  modalOpen: boolean;
  slotSwitcherCount: number;
  newFilePrompt: boolean;
}

export function slotViewKeyboardAction(
  input: SlotViewKeyboardDecisionInput,
): SlotViewKeyboardAction {
  if ((input.metaKey || input.ctrlKey) && input.key === 'b' && !input.inTerminal) {
    return { kind: 'toggle-sidebar' };
  }

  if (
    (input.metaKey || input.ctrlKey) &&
    input.shiftKey &&
    (input.key === 's' || input.key === 'S') &&
    !input.inTerminal &&
    !input.inEditable
  ) {
    return { kind: 'toggle-resource-panel' };
  }

  if ((input.metaKey || input.ctrlKey) && input.key === 's' && !input.inTerminal) {
    return { kind: 'save-file' };
  }

  const slotSwitchDirection =
    input.code === 'BracketLeft' ? -1 : input.code === 'BracketRight' ? 1 : 0;
  if (
    input.altKey &&
    !input.metaKey &&
    !input.ctrlKey &&
    !input.shiftKey &&
    !input.inTerminal &&
    !input.inEditable &&
    input.hasSlotId &&
    !input.modalOpen &&
    input.slotSwitcherCount > 1 &&
    slotSwitchDirection !== 0
  ) {
    return { kind: 'switch-relative-slot', direction: slotSwitchDirection };
  }

  if (input.key === 'Escape' && input.newFilePrompt) {
    return { kind: 'close-new-file-prompt' };
  }

  return { kind: 'none' };
}
