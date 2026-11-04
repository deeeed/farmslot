import { RUN_DETAIL_PANEL_DEFAULTS, type RunDetailPanelId } from '@farmslot/protocol';

import { collapsiblePanelOpen, toggleCollapsiblePanel } from '../shared/collapsible-panel.js';

export { RUN_DETAIL_PANEL_DEFAULTS, type RunDetailPanelId } from '@farmslot/protocol';

export function runDetailPanelOpen(id: RunDetailPanelId): boolean {
  return collapsiblePanelOpen(id, RUN_DETAIL_PANEL_DEFAULTS[id]);
}

export function toggleRunDetailPanel(id: RunDetailPanelId): boolean {
  return toggleCollapsiblePanel(id, RUN_DETAIL_PANEL_DEFAULTS[id]);
}
