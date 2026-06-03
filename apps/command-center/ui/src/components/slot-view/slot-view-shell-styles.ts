import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export function renderSlotViewShellStyles(): string {
  return `
      slot-view {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: ${colors.bgBase};
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
      }

      /* --- Header --- */
      slot-view .sv-header {
        display: flex;
        align-items: center;
        gap: ${spacing.lg};
        padding: ${spacing.sm} ${spacing.xl};
        background: ${colors.bgSurface};
        border-bottom: 1px solid #1e1e36;
        flex-shrink: 0;
        height: 38px;
        box-sizing: border-box;
        overflow-x: auto;
        scrollbar-width: none;
      }
      slot-view .sv-header > * {
        flex-shrink: 0;
      }
      slot-view .sv-header::-webkit-scrollbar {
        display: none;
      }
      slot-view .sv-back-btn {
        background: none;
        border: none;
        color: ${colors.textSecondary};
        cursor: pointer;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeMd};
        padding: ${spacing.sm};
      }
      slot-view .sv-back-btn:hover {
        color: ${colors.textPrimary};
      }
      slot-view .sv-slot-title {
        font-size: ${fonts.sizeLg};
        font-weight: 600;
      }
      slot-view .sv-slot-switcher {
        display: inline-flex;
        align-items: stretch;
        gap: 1px;
        min-width: 260px;
        max-width: 440px;
      }
      slot-view .sv-slot-switcher-select,
      slot-view .sv-slot-switcher-step {
        border: 1px solid #2a2a44;
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        height: 24px;
      }
      slot-view .sv-slot-switcher-select {
        min-width: 0;
        flex: 1 1 auto;
        padding: 0 8px;
        border-radius: 0;
      }
      slot-view .sv-slot-switcher-step {
        width: 26px;
        padding: 0;
        cursor: pointer;
      }
      slot-view .sv-slot-switcher-step:first-child {
        border-radius: ${radii.sm} 0 0 ${radii.sm};
      }
      slot-view .sv-slot-switcher-step:last-child {
        border-radius: 0 ${radii.sm} ${radii.sm} 0;
      }
      slot-view .sv-slot-switcher-select:hover,
      slot-view .sv-slot-switcher-step:hover:not(:disabled) {
        background: ${colors.bgCardHover};
        color: ${colors.textPrimary};
      }
      slot-view .sv-slot-switcher-step:disabled {
        cursor: default;
        opacity: 0.45;
      }
      slot-view .sv-lifecycle-badge {
        font-size: ${fonts.sizeXs};
        padding: 2px 8px;
        border-radius: 3px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: 600;
      }
      slot-view .sv-header-right {
        display: flex;
        align-items: center;
        gap: ${spacing.sm};
        margin-left: auto;
      }
      slot-view .sv-slot-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: ${spacing.sm};
        flex: 0 0 auto;
      }
      slot-view .sv-slot-action-btn {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: 2px 8px;
        border-radius: ${radii.sm};
        border: 1px solid #2a2a44;
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        cursor: pointer;
        white-space: nowrap;
      }
      slot-view .sv-slot-action-btn.primary {
        color: ${colors.accent};
        border-color: ${colors.accent}44;
        background: ${colors.accent}14;
      }
      slot-view .sv-slot-action-btn.danger {
        color: ${colors.statusFail};
        border-color: ${colors.statusFail}44;
        background: ${colors.statusFail}12;
      }
      slot-view .sv-slot-action-btn.failed {
        color: ${colors.statusFail};
        border-color: ${colors.statusFail};
        background: ${colors.statusFail}22;
      }
      slot-view .sv-slot-action-btn:disabled {
        cursor: wait;
        opacity: 0.55;
      }
      slot-view .sv-slot-action-btn:hover:not(:disabled) {
        background: ${colors.bgCardHover};
        color: ${colors.textPrimary};
      }
      slot-view .sv-editor-group {
        display: flex;
        gap: 1px;
        margin-left: ${spacing.md};
      }
      slot-view .sv-editor-btn {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: ${spacing.sm} ${spacing.md};
        border: 1px solid #2a2a44;
        background: ${colors.bgCard};
        color: ${colors.textMuted};
        cursor: pointer;
      }
      slot-view .sv-editor-btn:first-child {
        border-radius: ${radii.sm} 0 0 ${radii.sm};
      }
      slot-view .sv-editor-btn:last-child {
        border-radius: 0 ${radii.sm} ${radii.sm} 0;
      }
      slot-view .sv-editor-btn.active {
        background: ${colors.accent}22;
        border-color: ${colors.accent}44;
        color: ${colors.accent};
      }
      slot-view .sv-editor-btn:hover:not(.active) {
        background: ${colors.bgCardHover};
        color: ${colors.textPrimary};
      }
      slot-view .sv-open-editor-btn {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: ${spacing.sm} ${spacing.md};
        border-radius: ${radii.sm};
        border: 1px solid #2a2a44;
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        cursor: pointer;
      }
      slot-view .sv-open-editor-btn:hover {
        background: ${colors.bgCardHover};
        color: ${colors.textPrimary};
      }
      slot-view .sv-run-ctrl.history {
        background: ${colors.bgCard};
        color: ${colors.textSecondary};
        border: 1px solid ${colors.bgCardHover};
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-family: ${fonts.mono};
        cursor: pointer;
        margin-left: 4px;
      }
      slot-view .sv-run-ctrl.history:hover {
        background: ${colors.bgCardHover};
        color: ${colors.textPrimary};
      }
      slot-view .sv-pr-link {
        display: inline-flex;
        align-items: center;
        background: ${colors.accent}22;
        color: ${colors.accent};
        border: 1px solid ${colors.accent}44;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-family: ${fonts.mono};
        cursor: pointer;
        margin-left: 4px;
        text-decoration: none;
      }
      slot-view .sv-pr-link:hover {
        background: ${colors.accent}33;
      }

      /* --- Body (sidebar + editor) --- */
      slot-view .sv-body {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        position: relative;
      }

      /* --- Sidebar --- */
      slot-view .sv-sidebar {
        overflow: hidden;
        border-right: 1px solid #1e1e36;
        background: ${colors.bgSurface};
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
      }
      /* --- Activity bar --- */
      slot-view .sv-activity-bar {
        width: 36px;
        background: ${colors.bgSidebar};
        border-right: 1px solid #1e1e36;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: 4px;
        gap: 2px;
        flex-shrink: 0;
      }
      slot-view .sv-activity-btn {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: transparent;
        color: ${colors.textMuted};
        font-size: 16px;
        cursor: pointer;
        border-radius: 4px;
        transition:
          color 0.1s,
          background 0.1s;
        position: relative;
      }
      slot-view .sv-activity-btn:hover {
        color: ${colors.textSecondary};
        background: rgba(99, 102, 241, 0.08);
      }
      slot-view .sv-activity-btn.active {
        color: ${colors.textPrimary};
        background: rgba(99, 102, 241, 0.15);
      }
      slot-view .sv-activity-badge {
        position: absolute;
        top: 2px;
        right: 2px;
        min-width: 14px;
        height: 14px;
        background: ${colors.accent};
        color: #fff;
        font-size: 9px;
        font-weight: 600;
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 3px;
      }

      /* --- Explorer filter bar --- */
      slot-view .sv-explorer-filters {
        display: flex;
        gap: 4px;
        padding: 4px 8px;
        border-bottom: 1px solid #1e1e3622;
        flex-shrink: 0;
      }
      slot-view .sv-filter-btn {
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 1px 6px;
        border: 1px solid #2a2a44;
        border-radius: 3px;
        background: transparent;
        color: ${colors.textMuted};
        cursor: pointer;
        transition: all 0.1s;
      }
      slot-view .sv-filter-btn:hover {
        color: ${colors.textSecondary};
        background: rgba(99, 102, 241, 0.06);
      }
      slot-view .sv-filter-btn.active {
        background: ${colors.accent}22;
        border-color: ${colors.accent}44;
        color: ${colors.accent};
      }

      /* --- Search panel --- */
      slot-view .sv-search-panel {
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: 100%;
      }
      slot-view .sv-search-input {
        width: 100%;
        padding: 4px 8px;
        border: 1px solid #2a2a44;
        border-radius: 4px;
        background: ${colors.bgInput};
        color: ${colors.textPrimary};
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeSm};
        outline: none;
        box-sizing: border-box;
      }
      slot-view .sv-search-input:focus {
        border-color: ${colors.accent};
      }
      slot-view .sv-search-results {
        flex: 1;
        overflow-y: auto;
      }
      slot-view .sv-search-file-group {
        margin-bottom: 4px;
      }
      slot-view .sv-search-file-header {
        font-size: ${fonts.sizeXs};
        color: ${colors.textSecondary};
        font-weight: 600;
        padding: 2px 4px;
      }
      slot-view .sv-search-match {
        display: flex;
        gap: 8px;
        padding: 2px 4px 2px 16px;
        cursor: pointer;
        font-size: ${fonts.sizeXs};
        border-radius: 3px;
      }
      slot-view .sv-search-match:hover {
        background: rgba(99, 102, 241, 0.1);
      }
      slot-view .sv-search-line-num {
        color: ${colors.textMuted};
        min-width: 30px;
        text-align: right;
      }
      slot-view .sv-search-line-text {
        color: ${colors.textSecondary};
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      slot-view .sv-search-mode-toggle {
        display: flex;
        gap: 1px;
      }
      slot-view .sv-search-mode-btn {
        flex: 1;
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 3px 0;
        border: 1px solid #2a2a44;
        background: transparent;
        color: ${colors.textMuted};
        cursor: pointer;
      }
      slot-view .sv-search-mode-btn:first-child {
        border-radius: 4px 0 0 4px;
      }
      slot-view .sv-search-mode-btn:last-child {
        border-radius: 0 4px 4px 0;
      }
      slot-view .sv-search-mode-btn.active {
        background: ${colors.accent}22;
        border-color: ${colors.accent}44;
        color: ${colors.accent};
      }
      slot-view .sv-search-mode-btn:hover:not(.active) {
        color: ${colors.textSecondary};
        background: rgba(99, 102, 241, 0.05);
      }
      slot-view .sv-file-result-name {
        font-weight: 600;
        color: ${colors.textPrimary};
        font-size: ${fonts.sizeXs};
      }
      slot-view .sv-file-result-dir {
        color: ${colors.textMuted};
        font-size: ${fonts.sizeXs};
        margin-left: 4px;
      }
      slot-view .sv-search-status {
        padding: 8px;
        color: ${colors.textMuted};
        font-size: ${fonts.sizeXs};
      }
      slot-view .sv-sidebar-content {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
      }
      slot-view .sv-sidebar-content::-webkit-scrollbar {
        width: 6px;
      }
      slot-view .sv-sidebar-content::-webkit-scrollbar-thumb {
        background: ${colors.textMuted};
        border-radius: 3px;
      }
      /* Source panel needs flex column so pinned + source each scroll independently */
      slot-view .sv-sidebar-content.sv-source-layout {
        display: flex;
        flex-direction: column;
        overflow-y: hidden;
      }

      /* --- Resize handles --- */
      slot-view .sv-resize-h {
        width: 4px;
        cursor: col-resize;
        background: transparent;
        flex-shrink: 0;
        transition: background 0.15s;
      }
      slot-view .sv-resize-h:hover,
      slot-view .sv-resize-h.active {
        background: ${colors.accent};
      }
      slot-view .sv-resize-v {
        height: 4px;
        cursor: row-resize;
        background: transparent;
        flex-shrink: 0;
        transition: background 0.15s;
      }
      slot-view .sv-resize-v:hover,
      slot-view .sv-resize-v.active {
        background: ${colors.accent};
      }
      /* Section headers */
      slot-view .sv-section-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        cursor: pointer;
        user-select: none;
        text-transform: uppercase;
        font-size: ${fonts.sizeXs};
        letter-spacing: 0.05em;
        color: ${colors.textMuted};
        border-top: 1px solid #1e1e3622;
        flex-shrink: 0;
      }
      slot-view .sv-section-header:first-child {
        border-top: none;
      }
      slot-view .sv-section-header:hover {
        color: ${colors.textSecondary};
        background: rgba(99, 102, 241, 0.05);
      }
      slot-view .sv-section-arrow {
        font-size: 10px;
        width: 12px;
        text-align: center;
        flex-shrink: 0;
      }
      slot-view .sv-section-title {
        font-weight: 600;
      }
      slot-view .sv-section-badge {
        margin-left: auto;
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
      }
      slot-view .sv-unpin-btn {
        margin-left: auto;
        background: none;
        border: none;
        color: ${colors.textMuted};
        font-size: 14px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      slot-view .sv-unpin-btn:hover {
        color: ${colors.textPrimary};
      }
      slot-view .sv-pinned-body {
        padding: ${spacing.sm};
        overflow-y: auto;
        flex-shrink: 0;
      }
      slot-view .sv-pinned-body::-webkit-scrollbar {
        width: 6px;
      }
      slot-view .sv-pinned-body::-webkit-scrollbar-thumb {
        background: ${colors.textMuted};
        border-radius: 3px;
      }
      slot-view .sv-section-body {
        overflow: hidden;
      }
      slot-view .sv-section-body.sv-pinned-body {
        overflow-y: auto;
      }
      slot-view .sv-section-body.sv-source-body {
        overflow-y: auto;
      }
      slot-view .sv-files-body {
        padding: ${spacing.sm};
      }
      slot-view .sv-source-body {
        padding: ${spacing.sm};
        flex: 1;
        overflow-y: auto;
        min-height: 0;
      }
      slot-view .sv-source-body::-webkit-scrollbar {
        width: 6px;
      }
      slot-view .sv-source-body::-webkit-scrollbar-thumb {
        background: ${colors.textMuted};
        border-radius: 3px;
      }
      slot-view .sv-info-body,
      slot-view .sv-actions-body,
      slot-view .sv-task-body {
        padding: ${spacing.sm} ${spacing.lg};
      }
`;
}
