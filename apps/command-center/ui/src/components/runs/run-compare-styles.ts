import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const runCompareStyles = css`
  :host {
    display: block;
    height: 100%;
    overflow: auto;
    padding: ${unsafeCSS(spacing.lg)};
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .back {
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-size: ${unsafeCSS(fonts.sizeSm)};
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .back:hover {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  h2 {
    margin: 0 0 ${unsafeCSS(spacing.lg)} 0;
    font-size: ${unsafeCSS(fonts.sizeLg)};
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .empty {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    padding: ${unsafeCSS(spacing.xl)} 0;
    text-align: center;
  }
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${unsafeCSS(spacing.lg)};
  }
  .col-header {
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .col-title {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .col-title .ticket {
    font-size: 13px;
    font-weight: 600;
    color: ${unsafeCSS(colors.textPrimary)};
    cursor: pointer;
  }
  .col-title .ticket:hover {
    text-decoration: underline;
  }
  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
  }
  .flow-badge {
    color: #000;
  }
  .status-badge {
    border: 1px solid;
    background: transparent;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
    font-size: 11px;
  }
  .meta-label {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .meta-value {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .meta-value.diff {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .grade-inline {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .steps-section {
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .steps-section h3 {
    margin: 0 0 ${unsafeCSS(spacing.sm)} 0;
    font-size: 13px;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .step-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${unsafeCSS(spacing.lg)};
    margin-bottom: 2px;
  }
  .step-cell {
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 6px 10px;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .step-cell.missing {
    opacity: 0.3;
    font-style: italic;
  }
  .step-name {
    font-weight: 600;
    color: ${unsafeCSS(colors.textPrimary)};
    min-width: 80px;
  }
  .step-status {
    font-size: 10px;
    font-weight: 700;
  }
  .step-duration {
    color: ${unsafeCSS(colors.textMuted)};
    margin-left: auto;
  }
  .step-diff-marker {
    color: ${unsafeCSS(colors.statusWarn)};
    font-weight: 700;
    font-size: 10px;
  }
  .io-section {
    margin-top: 4px;
    padding: 4px 8px;
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: 3px;
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    max-height: 120px;
    overflow: auto;
    word-break: break-all;
  }
  .io-label {
    font-weight: 600;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .section-card {
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .section-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 13px;
    font-weight: 700;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .section-hint {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    line-height: 1.45;
  }
  .step-row.clickable {
    cursor: pointer;
  }
  .step-row.selected .step-cell {
    outline: 1px solid ${unsafeCSS(colors.accent)}88;
    background: ${unsafeCSS(colors.accent)}11;
  }
  .drill-grid,
  .evidence-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${unsafeCSS(spacing.lg)};
    align-items: start;
  }
  .drill-card {
    min-width: 0;
  }
  .drill-card-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    font-weight: 700;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .raw-block {
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 10px;
    line-height: 1.45;
    max-height: 260px;
    overflow: auto;
    padding: ${unsafeCSS(spacing.sm)};
    white-space: pre-wrap;
    word-break: break-word;
  }
  .inline-link {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
  }
  .inline-link:hover {
    text-decoration: underline;
  }
  .picker-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${unsafeCSS(spacing.lg)};
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .picker-card {
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.sm)};
  }
  .picker-card label {
    display: block;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .run-picker {
    width: 100%;
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
    padding: 6px 8px;
  }
  .mini-metrics {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    font-size: 11px;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .muted {
    color: ${unsafeCSS(colors.textMuted)};
  }
  @media (max-width: 1100px) {
    .columns,
    .step-row,
    .drill-grid,
    .evidence-grid,
    .picker-grid {
      grid-template-columns: 1fr;
    }
  }
`;
