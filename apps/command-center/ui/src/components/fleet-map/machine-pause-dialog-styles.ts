import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const machinePauseDialogStyles = css`
  :host {
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .mpd-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 40px 16px 16px;
    background: rgba(0, 0, 0, 0.68);
  }
  .mpd-panel {
    display: flex;
    width: min(1040px, 100%);
    max-height: calc(100vh - 56px);
    flex-direction: column;
    overflow: hidden;
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgSurface)};
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  }
  .mpd-header,
  .mpd-footer {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
    border-bottom: 1px solid #2a2a44;
  }
  .mpd-footer {
    border-top: 1px solid #2a2a44;
    border-bottom: 0;
  }
  .mpd-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: ${unsafeCSS(fonts.sizeMd)};
    font-weight: 700;
  }
  .mpd-subtitle,
  .mpd-muted {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .mpd-close,
  .mpd-button,
  .mpd-link-button,
  .mpd-tab {
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    cursor: pointer;
  }
  .mpd-close,
  .mpd-button,
  .mpd-tab {
    padding: 5px 10px;
  }
  .mpd-close:hover:not(:disabled),
  .mpd-button:hover:not(:disabled),
  .mpd-link-button:hover:not(:disabled),
  .mpd-tab:hover:not(:disabled) {
    border-color: ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.textPrimary)};
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }
  .mpd-body {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    overflow-y: auto;
    padding: ${unsafeCSS(spacing.lg)};
  }
  .mpd-banner,
  .mpd-card {
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgInput)}88;
  }
  .mpd-banner {
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.5;
  }
  .mpd-banner.error {
    border-color: ${unsafeCSS(colors.statusFail)}66;
    background: ${unsafeCSS(colors.statusFail)}10;
    color: ${unsafeCSS(colors.statusFail)};
  }
  .mpd-banner.stale,
  .mpd-banner.warning {
    border-color: ${unsafeCSS(colors.statusWarn)}66;
    background: ${unsafeCSS(colors.statusWarn)}10;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .mpd-banner.success {
    border-color: ${unsafeCSS(colors.statusOk)}55;
    background: ${unsafeCSS(colors.statusOk)}0d;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .mpd-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
  }
  .mpd-tab {
    display: grid;
    gap: 3px;
    padding: ${unsafeCSS(spacing.md)};
    text-align: left;
  }
  .mpd-tab strong {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .mpd-tab.active {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}18;
  }
  .mpd-tab-copy {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    line-height: 1.45;
  }
  .mpd-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }
  .mpd-stat {
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
  }
  .mpd-stat-label,
  .mpd-section-title {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .mpd-stat-value {
    display: block;
    margin-top: 3px;
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: ${unsafeCSS(fonts.sizeMd)};
  }
  .mpd-section {
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .mpd-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .mpd-selection-actions {
    display: flex;
    gap: 6px;
  }
  .mpd-link-button {
    padding: 2px 7px;
    background: transparent;
  }
  .mpd-runs,
  .mpd-processes {
    display: grid;
    gap: 4px;
  }
  .mpd-run,
  .mpd-process {
    display: grid;
    align-items: start;
    gap: ${unsafeCSS(spacing.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    border: 1px solid transparent;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .mpd-run {
    grid-template-columns: 20px minmax(150px, 1fr) minmax(120px, 0.8fr) minmax(200px, 1.6fr);
  }
  .mpd-process {
    grid-template-columns: minmax(160px, 1fr) 100px 100px minmax(140px, 1fr);
  }
  .mpd-run.rejected {
    opacity: 0.7;
    border-color: ${unsafeCSS(colors.statusFail)}33;
  }
  .mpd-run.error {
    border-color: ${unsafeCSS(colors.statusFail)}66;
  }
  .mpd-run input {
    accent-color: ${unsafeCSS(colors.accent)};
  }
  .mpd-run-title,
  .mpd-process-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .mpd-run-meta,
  .mpd-resources,
  .mpd-process-meta {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    line-height: 1.45;
  }
  .mpd-reason,
  .mpd-action-error {
    color: ${unsafeCSS(colors.statusFail)};
    line-height: 1.45;
  }
  .mpd-policy,
  .mpd-phase {
    color: ${unsafeCSS(colors.accent)};
    font-size: 10px;
  }
  .mpd-phase.complete,
  .mpd-phase.paused,
  .mpd-phase.restored {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .mpd-phase.failed,
  .mpd-phase.partial {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .mpd-residuals {
    color: ${unsafeCSS(colors.statusWarn)};
    line-height: 1.45;
  }
  .mpd-confirm {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .mpd-confirm input {
    accent-color: ${unsafeCSS(colors.statusWarn)};
  }
  .mpd-button.primary {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .mpd-button.danger {
    border-color: ${unsafeCSS(colors.statusWarn)}99;
    background: ${unsafeCSS(colors.statusWarn)}12;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .mpd-footer-actions {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
  }
  @media (max-width: 760px) {
    .mpd-backdrop {
      padding: 8px;
    }
    .mpd-panel {
      max-height: calc(100vh - 16px);
    }
    .mpd-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .mpd-run,
    .mpd-process {
      grid-template-columns: 20px 1fr;
    }
    .mpd-run > :not(input),
    .mpd-process > * {
      grid-column: 2;
    }
  }
`;
