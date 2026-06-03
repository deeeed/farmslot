import type { SlotView } from './slot-view.js';

export function closeSlotViewResourcePanel(view: SlotView): void {
  view._resourcePanelOpen = false;
  view._activeResourceId = '';
  view._saveLayout();
}

export function toggleSlotViewResourcePanel(view: SlotView): void {
  view._resourcePanelOpen = !view._resourcePanelOpen;
  view._saveLayout();
}

export function openSlotViewResourcePanelResource(view: SlotView, resourceId: string): void {
  if (!view._resourcePanelOpen) {
    view._resourcePanelOpen = true;
    view._saveLayout();
  }
  view._activeResourceId = resourceId;
  view._ensureResourcePanelSelection(resourceId);
}
