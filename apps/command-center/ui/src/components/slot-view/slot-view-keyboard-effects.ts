import type { SlotView } from './slot-view.js';
import { slotViewKeyboardAction } from './slot-view-keyboard-model.js';
import { toggleSlotViewResourcePanel } from './slot-view-resource-panel-effects.js';

export function handleSlotViewGlobalKey(view: SlotView, event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  const inTerminal = target.closest('terminal-view') !== null;
  const inEditable =
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
    null;

  const action = slotViewKeyboardAction({
    key: event.key,
    code: event.code,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    inTerminal,
    inEditable,
    hasSlotId: Boolean(view.slotId),
    modalOpen: view._hasModalOpen(),
    slotSwitcherCount: view._slotSwitcherEntries().length,
    newFilePrompt: view._newFilePrompt,
  });

  switch (action.kind) {
    case 'toggle-sidebar':
      event.preventDefault();
      view._toggleSidebar();
      return;
    case 'toggle-resource-panel':
      event.preventDefault();
      toggleSlotViewResourcePanel(view);
      return;
    case 'save-file':
      event.preventDefault();
      void view._saveFile();
      return;
    case 'switch-relative-slot':
      event.preventDefault();
      view._switchRelativeSlot(action.direction);
      return;
    case 'close-new-file-prompt':
      view._newFilePrompt = false;
      return;
    case 'none':
      return;
  }
}
