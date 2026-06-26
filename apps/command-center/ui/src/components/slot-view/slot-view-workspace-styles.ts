import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export function renderSlotViewWorkspaceStyles(): string {
  return `
      /* --- Info grid --- */
      slot-view .sv-info-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: ${spacing.sm} ${spacing.lg};
        margin-bottom: ${spacing.md};
      }
      slot-view .sv-info-key {
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
      }
      slot-view .sv-info-val {
        font-size: ${fonts.sizeXs};
        color: ${colors.textPrimary};
      }
      slot-view .sv-health-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px ${spacing.md};
        margin-top: ${spacing.sm};
      }
      slot-view .sv-health-label {
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
      }
      slot-view .sv-health-val {
        font-size: ${fonts.sizeXs};
        color: ${colors.textSecondary};
      }

      /* --- Checks --- */
      slot-view .sv-check-list {
        margin-top: ${spacing.sm};
      }
      slot-view .sv-check-item {
        display: flex;
        align-items: center;
        gap: ${spacing.md};
        padding: 2px 0;
      }
      slot-view .sv-check-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      slot-view .sv-check-name {
        font-size: ${fonts.sizeXs};
        color: ${colors.textPrimary};
      }
      slot-view .sv-check-detail {
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
        margin-left: auto;
      }

      /* --- Actions --- */
      slot-view .sv-actions-col {
        display: flex;
        flex-direction: column;
        gap: ${spacing.sm};
      }
      slot-view .sv-action-btn {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: ${spacing.sm} ${spacing.lg};
        border-radius: ${radii.sm};
        border: 1px solid #2a2a44;
        background: ${colors.bgCard};
        color: ${colors.textPrimary};
        cursor: pointer;
        text-align: left;
      }
      slot-view .sv-action-btn:hover {
        background: ${colors.bgCardHover};
      }
      slot-view .sv-action-btn:disabled {
        opacity: 0.4;
        cursor: wait;
      }
      slot-view .sv-action-btn.primary {
        background: ${colors.accent};
        border-color: ${colors.accent};
        color: #fff;
      }
      slot-view .sv-action-btn.danger {
        background: ${colors.statusFail}22;
        border-color: ${colors.statusFail}44;
        color: ${colors.statusFail};
      }
      slot-view .sv-action-btn.confirming {
        background: ${colors.statusWarn}22;
        border-color: ${colors.statusWarn};
        color: ${colors.statusWarn};
        animation: sv-pulse-border 0.6s ease-in-out infinite alternate;
      }
      @keyframes sv-pulse-border {
        from {
          border-color: ${colors.statusWarn}88;
        }
        to {
          border-color: ${colors.statusWarn};
        }
      }
      slot-view .sv-output-panel {
        background: ${colors.bgBase};
        border: 1px solid #1e1e36;
        border-radius: ${radii.sm};
        padding: ${spacing.sm};
        font-size: ${fonts.sizeXs};
        line-height: 1.4;
        overflow-y: auto;
        max-height: 150px;
        white-space: pre-wrap;
        word-break: break-all;
        margin-top: ${spacing.sm};
      }
      slot-view .sv-exit-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: ${fonts.sizeXs};
        font-weight: 600;
        margin-top: ${spacing.xs};
      }

      /* --- Task progress --- */
      slot-view .sv-task-header {
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
        margin-bottom: ${spacing.sm};
      }
      slot-view .sv-progress-bar {
        background: ${colors.bgInput};
        border-radius: 3px;
        height: 4px;
        margin-bottom: ${spacing.md};
        overflow: hidden;
      }
      slot-view .sv-progress-fill {
        height: 100%;
        background: ${colors.accent};
        border-radius: 3px;
        transition: width 0.3s;
      }
      slot-view .sv-task-step {
        display: flex;
        align-items: flex-start;
        gap: ${spacing.sm};
        padding: 1px 0;
        font-size: ${fonts.sizeXs};
      }
      slot-view .sv-task-checkbox {
        width: 10px;
        height: 10px;
        border: 1px solid #2a2a44;
        border-radius: 2px;
        flex-shrink: 0;
        margin-top: 2px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 7px;
      }
      slot-view .sv-task-checkbox.checked {
        background: ${colors.statusOk}22;
        border-color: ${colors.statusOk}44;
        color: ${colors.statusOk};
      }
      slot-view .sv-task-text {
        color: ${colors.textSecondary};
        line-height: 1.3;
      }
      slot-view .sv-task-text.checked {
        color: ${colors.textMuted};
        text-decoration: line-through;
      }

      /* --- Tab row (tabs + new file button) --- */
      slot-view .sv-tab-row {
        display: flex;
        align-items: stretch;
        flex-shrink: 0;
        height: 30px;
      }
      slot-view .sv-tab-row tab-bar {
        flex: 1;
        min-width: 0;
        overflow: hidden;
      }
      slot-view .sv-new-file-btn {
        width: 30px;
        height: 30px;
        border: none;
        background: ${colors.bgSurface};
        color: ${colors.textMuted};
        font-family: ${fonts.mono};
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
        border-left: 1px solid ${colors.bgCard};
        border-bottom: 1px solid ${colors.bgCard};
        display: flex;
        align-items: center;
        justify-content: center;
      }
      slot-view .sv-new-file-btn:hover {
        color: ${colors.textPrimary};
        background: rgba(99, 102, 241, 0.12);
      }

      /* --- New file bar --- */
      slot-view .sv-new-file-bar {
        display: flex;
        align-items: center;
        gap: ${spacing.sm};
        padding: ${spacing.sm} ${spacing.lg};
        background: ${colors.bgCard};
        border-bottom: 1px solid ${colors.accent}44;
        flex-shrink: 0;
      }
      slot-view .sv-new-file-label {
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
        white-space: nowrap;
      }
      slot-view .sv-new-file-input {
        flex: 1;
        padding: 3px 8px;
        border: 1px solid ${colors.accent}44;
        border-radius: 3px;
        background: ${colors.bgInput};
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeSm};
        outline: none;
      }
      slot-view .sv-new-file-input:focus {
        border-color: ${colors.accent};
      }
      slot-view .sv-new-file-ok {
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 3px 10px;
        border: 1px solid ${colors.accent}44;
        border-radius: 3px;
        background: ${colors.accent}22;
        color: ${colors.accent};
        cursor: pointer;
      }
      slot-view .sv-new-file-ok:hover {
        background: ${colors.accent}33;
      }
      slot-view .sv-new-file-cancel {
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 3px 10px;
        border: 1px solid #2a2a44;
        border-radius: 3px;
        background: transparent;
        color: ${colors.textMuted};
        cursor: pointer;
      }
      slot-view .sv-new-file-cancel:hover {
        color: ${colors.textPrimary};
      }

      /* --- Right column (editor + terminal) --- */
      slot-view .sv-right-col {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow: hidden;
      }

      /* --- Editor row: editor + optional resource panel side by side --- */
      slot-view .sv-editor-row {
        flex: 1;
        display: flex;
        flex-direction: row;
        min-height: 60px;
        overflow: hidden;
      }

      /* --- Editor area --- */
      slot-view .sv-editor {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }
      slot-view .sv-editor-header {
        display: flex;
        align-items: center;
        gap: ${spacing.md};
        padding: 0 ${spacing.lg};
        height: 28px;
        background: ${colors.bgCard};
        border-bottom: 1px solid #1e1e36;
        flex-shrink: 0;
      }
      slot-view .sv-editor-filepath {
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }
      slot-view .sv-editor-header-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      slot-view .sv-mode-toggle {
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 2px 8px;
        border: 1px solid #2a2a44;
        border-radius: 3px;
        background: transparent;
        color: ${colors.textMuted};
        cursor: pointer;
        transition: all 0.1s;
      }
      slot-view .sv-mode-toggle:hover {
        color: ${colors.textPrimary};
        background: rgba(99, 102, 241, 0.1);
      }
      slot-view .sv-mode-toggle.active {
        background: ${colors.accent}22;
        border-color: ${colors.accent}44;
        color: ${colors.accent};
      }
      slot-view .sv-save-btn {
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 2px 8px;
        border: 1px solid ${colors.statusOk}44;
        border-radius: 3px;
        background: ${colors.statusOk}22;
        color: ${colors.statusOk};
        cursor: pointer;
      }
      slot-view .sv-save-btn:hover {
        background: ${colors.statusOk}33;
      }
      slot-view .sv-save-btn.saved {
        background: ${colors.statusOk}33;
        border-color: ${colors.statusOk}66;
        color: ${colors.statusOk};
      }
      slot-view .sv-save-btn.saving {
        opacity: 0.5;
        cursor: wait;
      }
      slot-view .sv-editor-content {
        flex: 1;
        position: relative;
        min-height: 0;
      }
      slot-view .sv-editor-content > * {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }
      slot-view .sv-image-viewer {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        overflow: auto;
        background: ${colors.bgBase};
        padding: ${spacing.lg};
      }
      slot-view .sv-image-viewer img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: ${radii.sm};
      }
      slot-view .sv-image-viewer video {
        max-width: 100%;
        max-height: 100%;
      }
      slot-view .sv-empty-editor {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: ${colors.textMuted};
        font-size: ${fonts.sizeSm};
      }

      /* --- Resource panel column (rightmost) --- */
      slot-view .sv-stream-col {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        background: ${colors.bgSurface};
        transition: width 0.2s ease;
        overflow: hidden;
      }

      /* --- Resource chips in header --- */
      slot-view .sv-resource-chips {
        display: flex;
        gap: 4px;
        margin-left: 8px;
      }
      slot-view .sv-resource-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 1px 7px;
        border: 1px solid #2a2a44;
        border-radius: 10px;
        background: transparent;
        font-family: ${fonts.mono};
        font-size: 9px;
        color: ${colors.textMuted};
        cursor: pointer;
        transition: all 0.15s;
      }
      slot-view .sv-resource-chip:hover {
        background: rgba(99, 102, 241, 0.08);
        color: ${colors.textSecondary};
      }
      slot-view .sv-resource-chip.active {
        background: ${colors.accent}18;
        color: ${colors.accent};
        border-color: ${colors.accent}44;
      }
      slot-view .sv-rchip-dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: ${colors.textMuted};
      }
      slot-view .sv-rchip-dot.running {
        background: ${colors.statusOk};
      }
      slot-view .sv-rchip-dot.stopped {
        background: ${colors.statusFail};
      }
      slot-view .sv-rchip-dot.error {
        background: ${colors.statusFail};
      }

      slot-view .sv-stream-collapsed {
        width: 24px;
        flex-shrink: 0;
        border-left: 1px solid #1e1e36;
        background: ${colors.bgCard};
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      slot-view .sv-stream-collapsed:hover {
        background: rgba(99, 102, 241, 0.08);
      }
      slot-view .sv-stream-collapsed-label {
        writing-mode: vertical-rl;
        font-family: ${fonts.mono};
        font-size: 9px;
        color: ${colors.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.15em;
        user-select: none;
      }
`;
}
