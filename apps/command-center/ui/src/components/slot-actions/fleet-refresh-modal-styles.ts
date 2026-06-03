import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const fleetRefreshModalStyles = css`
  .frm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 60px 16px 16px;
    z-index: 1000;
  }
  .frm-panel {
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.md)};
    width: min(960px, 100%);
    max-height: calc(100vh - 80px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .frm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    border-bottom: 1px solid #2a2a44;
  }
  .frm-title {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
  }
  .frm-title-meta {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
    margin-left: ${unsafeCSS(spacing.sm)};
  }
  .frm-filter-badge {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.accent)};
    margin-top: 4px;
  }
  .frm-pr-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.statusWarn)};
    padding: 6px 10px;
    margin: 0 0 6px;
    background: ${unsafeCSS(colors.statusWarn)}14;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}44;
    border-radius: ${unsafeCSS(radii.sm)};
  }
  .frm-pr-loading-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${unsafeCSS(colors.statusWarn)};
    animation: frm-pr-pulse 1s ease-in-out infinite;
  }
  @keyframes frm-pr-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }
  .frm-close {
    background: transparent;
    border: 1px solid #2a2a44;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: 4px 10px;
    border-radius: ${unsafeCSS(radii.sm)};
    cursor: pointer;
  }
  .frm-close:hover {
    color: ${unsafeCSS(colors.textPrimary)};
    border-color: ${unsafeCSS(colors.accent)};
  }
  .frm-body {
    overflow-y: auto;
    flex: 1;
    padding: ${unsafeCSS(spacing.sm)} 0;
  }
  .frm-section {
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
  }
  .frm-section-header {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    cursor: pointer;
    user-select: none;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 4px 0;
  }
  .frm-section-header.safe {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .frm-section-header.force {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .frm-section-header.hidden {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-section-arrow {
    display: inline-block;
    width: 10px;
    transition: transform 0.12s ease;
  }
  .frm-section-arrow.open {
    transform: rotate(90deg);
  }
  .frm-section-count {
    color: ${unsafeCSS(colors.textMuted)};
    font-weight: 400;
  }
  .frm-select-all {
    margin-left: auto;
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
    background: transparent;
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 2px 8px;
    cursor: pointer;
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .frm-select-all:hover {
    color: ${unsafeCSS(colors.textPrimary)};
    border-color: ${unsafeCSS(colors.accent)};
  }
  .frm-select-all.confirming {
    color: ${unsafeCSS(colors.statusWarn)};
    border-color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.statusWarn)}22;
  }
  .frm-warn {
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
    padding: 2px 0 6px 18px;
  }
  .frm-row {
    display: grid;
    grid-template-columns: 18px minmax(160px, 1fr) minmax(140px, 1fr) minmax(160px, 2fr) auto;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
    padding: 6px 4px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    border-radius: ${unsafeCSS(radii.sm)};
    cursor: pointer;
    border: 1px solid transparent;
  }
  .frm-row:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }
  .frm-row.expanded {
    background: ${unsafeCSS(colors.bgCardHover)};
  }
  .frm-row.running {
    background: ${unsafeCSS(colors.accent)}14;
    border-color: ${unsafeCSS(colors.accent)}44;
    animation: frm-pulse 1.4s ease-in-out infinite;
  }
  .frm-row.refreshed {
    border-left: 3px solid ${unsafeCSS(colors.statusOk)};
  }
  .frm-row.failed {
    border-left: 3px solid ${unsafeCSS(colors.statusFail)};
  }
  .frm-row.skipped {
    border-left: 3px solid ${unsafeCSS(colors.statusWarn)};
  }
  .frm-row.cancelled {
    border-left: 3px solid ${unsafeCSS(colors.textMuted)};
  }
  @keyframes frm-pulse {
    0%,
    100% {
      background: ${unsafeCSS(colors.accent)}10;
    }
    50% {
      background: ${unsafeCSS(colors.accent)}22;
    }
  }
  .frm-row input[type='checkbox'] {
    cursor: pointer;
    accent-color: ${unsafeCSS(colors.accent)};
  }
  .frm-row .slot-id {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
  }
  .frm-row .branch {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-row .branch.stale {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .frm-row .meta {
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-row .status-badge {
    padding: 1px 8px;
    border-radius: ${unsafeCSS(radii.sm)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    white-space: nowrap;
  }
  .frm-row .status-badge.idle {
    background: #2a2a44;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-row .status-badge.pending {
    background: ${unsafeCSS(colors.textMuted)}33;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-row .status-badge.running {
    background: ${unsafeCSS(colors.accent)}33;
    color: ${unsafeCSS(colors.accent)};
  }
  .frm-row .status-badge.refreshed {
    background: ${unsafeCSS(colors.statusOk)}22;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .frm-row .status-badge.failed {
    background: ${unsafeCSS(colors.statusFail)}22;
    color: ${unsafeCSS(colors.statusFail)};
  }
  .frm-row .status-badge.skipped {
    background: ${unsafeCSS(colors.statusWarn)}22;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .frm-row .status-badge.cancelled {
    background: ${unsafeCSS(colors.textMuted)}22;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-row .force-btn {
    background: transparent;
    border: 1px solid ${unsafeCSS(colors.statusFail)}66;
    color: ${unsafeCSS(colors.statusFail)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    padding: 2px 8px;
    border-radius: ${unsafeCSS(radii.sm)};
    cursor: pointer;
  }
  .frm-row .force-btn:hover {
    background: ${unsafeCSS(colors.statusFail)}22;
    border-color: ${unsafeCSS(colors.statusFail)};
  }
  .frm-row .pr-state.merged {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .frm-row .pr-state.open {
    color: ${unsafeCSS(colors.statusFail)};
    font-weight: 600;
  }
  .frm-row .pr-state.closed {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-row.danger {
    border-left: 3px solid ${unsafeCSS(colors.statusFail)};
    background: ${unsafeCSS(colors.statusFail)}0a;
  }
  .frm-row.danger:hover {
    background: ${unsafeCSS(colors.statusFail)}1a;
  }
  .frm-row.danger .slot-id {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .frm-section-header.danger {
    color: ${unsafeCSS(colors.statusFail)};
    font-weight: 700;
  }
  .frm-warn.danger {
    color: ${unsafeCSS(colors.statusFail)};
    padding: 8px 18px;
    background: ${unsafeCSS(colors.statusFail)}0a;
    border-radius: ${unsafeCSS(radii.sm)};
    margin: 4px 0;
    line-height: 1.5;
  }
  .frm-allow-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.statusFail)};
  }
  .frm-allow-toggle button {
    background: transparent;
    border: 1px solid ${unsafeCSS(colors.statusFail)}66;
    color: ${unsafeCSS(colors.statusFail)};
    padding: 4px 12px;
    border-radius: ${unsafeCSS(radii.sm)};
    cursor: pointer;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .frm-allow-toggle button:hover {
    background: ${unsafeCSS(colors.statusFail)}22;
  }
  .frm-allow-toggle button.confirming {
    background: ${unsafeCSS(colors.statusFail)}33;
    border-color: ${unsafeCSS(colors.statusFail)};
    animation: frm-pulse-fail 1.2s ease-in-out infinite;
  }
  .frm-allow-toggle button.active {
    background: ${unsafeCSS(colors.statusFail)}22;
    border-color: ${unsafeCSS(colors.statusFail)};
  }
  @keyframes frm-pulse-fail {
    0%,
    100% {
      background: ${unsafeCSS(colors.statusFail)}22;
    }
    50% {
      background: ${unsafeCSS(colors.statusFail)}55;
    }
  }
  .frm-log-tail {
    grid-column: 1 / -1;
    padding: 4px 8px 4px 22px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .frm-log-full {
    grid-column: 1 / -1;
    max-height: 220px;
    overflow-y: auto;
    background: #000;
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    white-space: pre-wrap;
    padding: ${unsafeCSS(spacing.sm)};
    border-radius: ${unsafeCSS(radii.sm)};
    margin: 4px 0 0;
    line-height: 1.4;
  }
  .frm-empty {
    padding: ${unsafeCSS(spacing.lg)};
    text-align: center;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .frm-error {
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    color: ${unsafeCSS(colors.statusFail)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .frm-footer {
    border-top: 1px solid #2a2a44;
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
  }
  .frm-footer .progress {
    flex: 1;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
  }
  .frm-footer .progress strong {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .frm-action-btn {
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textPrimary)};
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 6px 14px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    cursor: pointer;
  }
  .frm-action-btn.primary {
    border-color: ${unsafeCSS(colors.accent)}88;
    color: ${unsafeCSS(colors.accent)};
  }
  .frm-action-btn.primary:hover:not(:disabled) {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .frm-action-btn.danger {
    border-color: ${unsafeCSS(colors.statusFail)}66;
    color: ${unsafeCSS(colors.statusFail)};
  }
  .frm-action-btn.danger:hover:not(:disabled) {
    background: ${unsafeCSS(colors.statusFail)}22;
  }
  .frm-action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;
