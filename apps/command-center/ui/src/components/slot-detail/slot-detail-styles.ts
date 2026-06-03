import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const slotDetailStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${unsafeCSS(colors.bgBase)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.lg)};
    padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
    background: ${unsafeCSS(colors.bgSurface)};
    border-bottom: 1px solid #1e1e36;
    flex-shrink: 0;
  }

  .back-btn {
    background: none;
    border: none;
    color: ${unsafeCSS(colors.textSecondary)};
    cursor: pointer;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeMd)};
    padding: ${unsafeCSS(spacing.sm)};
  }

  .back-btn:hover {
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .view-tabs {
    display: flex;
    gap: 0;
    margin-left: ${unsafeCSS(spacing.lg)};
  }

  .view-tab {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
    border: none;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 2px solid transparent;
    transition:
      color 0.1s,
      border-color 0.1s;
  }

  .view-tab:hover {
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .view-tab.active {
    color: ${unsafeCSS(colors.accent)};
    border-bottom-color: ${unsafeCSS(colors.accent)};
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    margin-left: auto;
  }

  .header-link {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    border-radius: ${unsafeCSS(radii.sm)};
    border: 1px solid #2a2a44;
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textSecondary)};
    cursor: pointer;
    text-decoration: none;
  }

  .header-link:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .editor-group {
    display: flex;
    gap: 1px;
  }

  .editor-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    border: 1px solid #2a2a44;
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    text-decoration: none;
  }

  .editor-btn:first-child {
    border-radius: ${unsafeCSS(radii.sm)} 0 0 ${unsafeCSS(radii.sm)};
  }
  .editor-btn:last-child {
    border-radius: 0 ${unsafeCSS(radii.sm)} ${unsafeCSS(radii.sm)} 0;
  }

  .editor-btn.active {
    background: ${unsafeCSS(colors.accent)}22;
    border-color: ${unsafeCSS(colors.accent)}44;
    color: ${unsafeCSS(colors.accent)};
  }

  .editor-btn:hover:not(.active) {
    background: ${unsafeCSS(colors.bgCardHover)};
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .slot-title {
    font-size: ${unsafeCSS(fonts.sizeLg)};
    font-weight: 600;
  }

  .lifecycle-badge {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: 2px 8px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }

  .tab-content {
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .detail-body {
    height: 100%;
    overflow-y: auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto auto;
    gap: ${unsafeCSS(spacing.lg)};
    padding: ${unsafeCSS(spacing.lg)};
  }

  .detail-body::-webkit-scrollbar {
    width: 6px;
  }
  .detail-body::-webkit-scrollbar-thumb {
    background: ${unsafeCSS(colors.textMuted)};
    border-radius: 3px;
  }

  /* Section cards */
  .section {
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid #1e1e36;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.lg)};
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .section-title {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: ${unsafeCSS(spacing.md)};
    flex-shrink: 0;
  }

  /* Info grid */
  .info-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
  }

  .info-key {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
  }

  .info-val {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textPrimary)};
  }

  /* Health checks */
  .check-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .check-item {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.sm)} 0;
    border-bottom: 1px solid #1e1e3622;
  }

  .check-item:last-child {
    border-bottom: none;
  }

  .check-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .check-name {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .check-detail {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
    margin-left: auto;
  }

  /* Actions */
  .actions-row {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
  }

  .action-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
    border-radius: ${unsafeCSS(radii.sm)};
    border: 1px solid #2a2a44;
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textPrimary)};
    cursor: pointer;
  }

  .action-btn:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }
  .action-btn:disabled {
    opacity: 0.4;
    cursor: wait;
  }

  .action-btn.primary {
    background: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)};
    color: #fff;
  }

  .action-btn.danger {
    background: ${unsafeCSS(colors.statusFail)}22;
    border-color: ${unsafeCSS(colors.statusFail)}44;
    color: ${unsafeCSS(colors.statusFail)};
  }

  .action-btn.confirming {
    background: ${unsafeCSS(colors.statusWarn)}22;
    border-color: ${unsafeCSS(colors.statusWarn)};
    color: ${unsafeCSS(colors.statusWarn)};
    animation: pulse-border 0.6s ease-in-out infinite alternate;
  }

  @keyframes pulse-border {
    from {
      border-color: ${unsafeCSS(colors.statusWarn)}88;
    }
    to {
      border-color: ${unsafeCSS(colors.statusWarn)};
    }
  }

  /* Task progress */
  .progress-bar-container {
    background: ${unsafeCSS(colors.bgInput)};
    border-radius: 3px;
    height: 6px;
    margin-bottom: ${unsafeCSS(spacing.md)};
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: ${unsafeCSS(colors.accent)};
    border-radius: 3px;
    transition: width 0.3s;
  }

  .task-step {
    display: flex;
    align-items: flex-start;
    gap: ${unsafeCSS(spacing.md)};
    padding: 2px 0;
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .task-checkbox {
    width: 12px;
    height: 12px;
    border: 1px solid #2a2a44;
    border-radius: 2px;
    flex-shrink: 0;
    margin-top: 1px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
  }

  .task-checkbox.checked {
    background: ${unsafeCSS(colors.statusOk)}22;
    border-color: ${unsafeCSS(colors.statusOk)}44;
    color: ${unsafeCSS(colors.statusOk)};
  }

  .task-text {
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .task-text.checked {
    color: ${unsafeCSS(colors.textMuted)};
    text-decoration: line-through;
  }

  /* Output panel */
  .output-panel {
    background: ${unsafeCSS(colors.bgBase)};
    border: 1px solid #1e1e36;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.md)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.4;
    overflow-y: auto;
    min-height: 100px;
    white-space: pre-wrap;
    word-break: break-all;
    flex: 1;
  }

  .exit-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    font-weight: 600;
    margin-top: ${unsafeCSS(spacing.sm)};
  }

  /* Terminal bottom panel */
  .terminal-panel {
    flex-shrink: 0;
    border-top: 1px solid #1e1e36;
    background: ${unsafeCSS(colors.bgSurface)};
    display: flex;
    flex-direction: column;
  }

  .terminal-toggle {
    display: flex;
    align-items: center;
    padding: ${unsafeCSS(spacing.xs)} ${unsafeCSS(spacing.lg)};
    cursor: pointer;
    user-select: none;
  }

  .terminal-toggle span {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .terminal-toggle:hover span {
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .terminal-body {
    height: 250px;
    overflow: hidden;
    display: flex;
  }

  terminal-view {
    flex: 1;
    min-height: 0;
  }

  slot-workspace {
    display: block;
    height: 100%;
  }
`;
