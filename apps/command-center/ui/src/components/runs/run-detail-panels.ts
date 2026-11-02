import { collapsiblePanelOpen, toggleCollapsiblePanel } from '../shared/collapsible-panel.js';

/**
 * Run detail's collapsible panels, below the always-visible pipeline canvas, and
 * whether each opens before the viewer chooses. The terminal keeps its own per-run
 * choice (`run-worker-panel-preferences`), since opening it attaches to the slot.
 */
export const RUN_DETAIL_PANEL_DEFAULTS = {
  'run-step-progress': true,
  'run-review-history': false,
  'run-artifacts': false,
  'run-acceptance': true,
  'run-results': true,
  'run-sessions': false,
  'run-posture': false,
  'run-grade': false,
} as const;

export type RunDetailPanelId = keyof typeof RUN_DETAIL_PANEL_DEFAULTS;

export function runDetailPanelOpen(id: RunDetailPanelId): boolean {
  return collapsiblePanelOpen(id, RUN_DETAIL_PANEL_DEFAULTS[id]);
}

export function toggleRunDetailPanel(id: RunDetailPanelId): boolean {
  return toggleCollapsiblePanel(id, RUN_DETAIL_PANEL_DEFAULTS[id]);
}
