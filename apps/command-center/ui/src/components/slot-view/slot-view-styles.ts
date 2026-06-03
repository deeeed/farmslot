import { html } from 'lit';

import type { RecoveryPhase } from '../../utils/reconnect.js';

import { renderSlotViewPanelStyles } from './slot-view-panel-styles.js';
import { renderSlotViewShellStyles } from './slot-view-shell-styles.js';
import { renderSlotViewWorkspaceStyles } from './slot-view-workspace-styles.js';

export function renderSlotViewStyles(recoveryPhase: RecoveryPhase) {
  return html`
    <style>
      ${renderSlotViewShellStyles()}
      ${renderSlotViewWorkspaceStyles()}
      ${renderSlotViewPanelStyles(recoveryPhase)}
    </style>
  `;
}
