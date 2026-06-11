import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import type { RecoveryPhase } from '../../utils/reconnect.js';

export function renderSlotViewPanelStyles(recoveryPhase: RecoveryPhase): string {
  return `
      /* --- Terminal panel (inside right column) --- */
      slot-view .sv-terminal-panel {
        flex-shrink: 0;
        background: ${colors.bgSurface};
        display: flex;
        flex-direction: column;
      }
      slot-view .sv-bottom-tabs {
        display: flex;
        align-items: center;
        border-bottom: 1px solid #1e1e36;
        flex-shrink: 0;
        height: 28px;
      }
      slot-view .sv-bottom-tab {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: 0 ${spacing.lg};
        height: 28px;
        border: none;
        background: transparent;
        color: ${colors.textMuted};
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        transition: color 0.1s;
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      slot-view .sv-bottom-tab:hover {
        color: ${colors.textSecondary};
      }
      slot-view .sv-bottom-tab.active {
        color: ${colors.textPrimary};
      }
      slot-view .sv-bottom-tab.active::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: ${colors.accent};
      }
      slot-view .sv-bottom-tab-badge {
        background: ${colors.accent};
        color: #fff;
        font-size: 9px;
        font-weight: 600;
        padding: 0 4px;
        border-radius: 7px;
        min-width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      slot-view .sv-bottom-tab-badge.error {
        background: ${colors.statusFail};
      }
      slot-view .sv-bottom-tab-badge.warn {
        background: ${colors.statusWarn};
        color: #000;
      }
      slot-view .sv-bottom-collapse {
        margin-left: auto;
        background: none;
        border: none;
        color: ${colors.textMuted};
        font-size: 12px;
        cursor: pointer;
        padding: 0 ${spacing.lg};
        height: 28px;
      }
      slot-view .sv-bottom-collapse:hover {
        color: ${colors.textSecondary};
      }
      slot-view .sv-terminal-body {
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      slot-view .sv-agent-contexts {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 8px;
        border-bottom: 1px solid #1e1e36;
        background: ${colors.bgSurface};
        overflow-x: auto;
        flex-shrink: 0;
      }
      slot-view .sv-agent-context {
        display: inline-grid;
        grid-template-columns: auto auto;
        gap: 2px 8px;
        align-items: center;
        min-width: 132px;
        padding: 5px 7px;
        border: 1px solid #2a2a44;
        border-radius: ${radii.sm};
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        text-align: left;
        cursor: pointer;
      }
      slot-view .sv-agent-context.active {
        border-color: ${colors.accent};
        background: ${colors.accent}1a;
        color: ${colors.textPrimary};
        box-shadow: inset 0 2px 0 0 ${colors.accent};
      }
      slot-view .sv-agent-context.disabled {
        opacity: 0.5;
        cursor: not-allowed;
        border-style: dashed;
      }
      slot-view .sv-agent-context.disabled .sv-agent-status {
        color: ${colors.statusFail};
      }
      slot-view .sv-agent-role {
        font-weight: 600;
        text-transform: uppercase;
      }
      slot-view .sv-agent-status {
        color: ${colors.textMuted};
        text-transform: uppercase;
      }
      slot-view .sv-agent-count {
        color: ${colors.accent};
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      slot-view .sv-agent-task {
        grid-column: 1 / -1;
        color: ${colors.textMuted};
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      slot-view terminal-view {
        flex: 1;
        min-height: 0;
      }
      slot-view .sv-run-panel {
        border-top: 1px solid ${colors.bgCard};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
      }
      slot-view .sv-run-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 12px;
        cursor: pointer;
        background: ${colors.bgSurface};
      }
      slot-view .sv-run-bar:hover {
        background: ${colors.bgCard};
      }
      slot-view .sv-run-body {
        max-height: 400px;
        overflow-y: auto;
        background: ${colors.bgBase};
        border-top: 1px solid ${colors.bgCard};
        padding: 8px;
      }
      slot-view .sv-run-link {
        color: ${colors.accent};
        font-size: 10px;
        text-decoration: none;
      }
      slot-view .sv-run-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }
      slot-view .sv-run-action {
        display: inline-flex;
        align-items: center;
        border: 1px solid ${colors.accent}55;
        border-radius: 4px;
        color: ${colors.accent};
        padding: 3px 8px;
        text-decoration: none;
        background: ${colors.accent}11;
      }
      slot-view .sv-run-action.muted {
        border-color: ${colors.bgCardHover};
        color: ${colors.textSecondary};
        background: ${colors.bgCard};
      }
      slot-view .sv-run-action.accent {
        border-color: ${colors.accent};
      }
      slot-view .sv-task-panel-col {
        display: flex;
        flex-direction: column;
        border-left: 1px solid ${colors.bgCard};
        overflow: hidden;
      }
      slot-view .sv-task-panel-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        font-size: ${fonts.sizeXs};
        font-weight: 600;
        font-family: ${fonts.mono};
        color: ${colors.textPrimary};
        background: ${colors.bgSurface};
        border-bottom: 2px solid ${colors.accent};
        min-width: 0;
      }
      slot-view .sv-task-panel-role {
        color: ${colors.accent};
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      slot-view .sv-task-breadcrumb {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        border-bottom: 1px solid ${colors.bgCard};
        background: ${colors.bgBase};
      }
      slot-view .sv-task-crumb {
        background: none;
        border: none;
        padding: 0 2px;
        color: ${colors.textMuted};
        font-family: inherit;
        font-size: inherit;
        cursor: pointer;
        letter-spacing: 0.5px;
      }
      slot-view .sv-task-crumb:not(:disabled):hover {
        color: ${colors.textPrimary};
        text-decoration: underline;
      }
      slot-view .sv-task-crumb.active {
        color: ${colors.accent};
        font-weight: 700;
        cursor: default;
      }
      slot-view .sv-task-crumb.disabled {
        opacity: 0.4;
        cursor: not-allowed;
        text-decoration: line-through;
      }
      slot-view .sv-task-crumb-sep {
        color: ${colors.textMuted};
        opacity: 0.6;
      }
      slot-view .sv-task-panel-close {
        margin-left: auto;
        flex-shrink: 0;
        background: none;
        border: none;
        color: ${colors.textMuted};
        cursor: pointer;
        font-size: 14px;
        padding: 0 4px;
      }
      slot-view .sv-task-panel-close:hover {
        color: ${colors.textPrimary};
      }
      slot-view .sv-task-panel-body {
        flex: 1;
        overflow-y: auto;
      }

      /* --- Review drawer panel --- */
      slot-view .sv-review-col {
        display: flex;
        flex-direction: column;
        border-left: 1px solid #1e1e36;
        overflow: hidden;
        flex-shrink: 0;
        background: ${colors.bgSurface};
      }
      slot-view .sv-review-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        font-size: ${fonts.sizeXs};
        font-weight: 600;
        font-family: ${fonts.mono};
        color: ${colors.textPrimary};
        background: ${colors.bgSurface};
        border-bottom: 1px solid #1e1e36;
        flex-shrink: 0;
      }
      slot-view .sv-review-body {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
      }
      slot-view .sv-review-collapsed {
        border-left: 1px solid #1e1e36;
      }
      slot-view .sv-recovery-overlay {
        position: absolute;
        inset: 0;
        z-index: 30;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(10, 10, 15, 0.76);
        backdrop-filter: blur(2px);
      }
      slot-view .sv-recovery-card {
        width: min(420px, calc(100% - 32px));
        padding: 18px 20px;
        border-radius: ${radii.md};
        border: 1px solid ${colors.accent}44;
        background: ${colors.bgSurface};
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.4);
        display: flex;
        flex-direction: column;
        gap: 10px;
        text-align: left;
      }
      slot-view .sv-recovery-eyebrow {
        font-size: ${fonts.sizeXs};
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: ${recoveryPhase === 'error' ? colors.statusFail : colors.accent};
      }
      slot-view .sv-recovery-title {
        font-size: ${fonts.sizeMd};
        font-weight: 700;
        color: ${colors.textPrimary};
      }
      slot-view .sv-recovery-copy {
        font-size: ${fonts.sizeSm};
        line-height: 1.5;
        color: ${colors.textSecondary};
      }
      slot-view .sv-recovery-meta {
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
      }
      slot-view .sv-recovery-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }
      slot-view .sv-recovery-btn {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: 7px 12px;
        border-radius: ${radii.sm};
        border: 1px solid ${colors.accent}44;
        background: ${colors.accent}22;
        color: ${colors.accent};
        cursor: pointer;
      }
      slot-view .sv-recovery-btn:hover {
        background: ${colors.accent}33;
      }
      slot-view .sv-recovery-btn:disabled {
        opacity: 0.45;
        cursor: wait;
      }
`;
}
