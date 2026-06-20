import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const familyObservabilityLayoutStyles = css`
  :host {
    display: block;
    height: 100%;
    overflow: auto;
    padding: ${unsafeCSS(spacing.lg)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    box-sizing: border-box;
  }
  .back {
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-size: 12px;
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .topbar {
    display: flex;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.lg)};
    align-items: flex-start;
    margin-bottom: ${unsafeCSS(spacing.lg)};
  }
  .eyebrow,
  .muted {
    color: ${unsafeCSS(colors.textMuted)};
  }
  h2 {
    margin: 4px 0 8px;
  }
  .summary {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 12px;
  }
  .top-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
  }
  .action-link,
  .action-btn {
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
    background: transparent;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 6px 10px;
    text-decoration: none;
    font-family: inherit;
    font-size: 12px;
  }
  .metrics-grid,
  .content-grid {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
  }
  .metrics-grid {
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    margin-bottom: ${unsafeCSS(spacing.lg)};
  }
  .content-grid {
    grid-template-columns: 1.2fr 1fr;
    margin-bottom: ${unsafeCSS(spacing.lg)};
  }
  .content-grid.family-run-focus {
    grid-template-columns: minmax(300px, 0.55fr) minmax(0, 1.45fr);
    align-items: start;
  }
  .primary-run-selector {
    position: sticky;
    top: ${unsafeCSS(spacing.md)};
    max-height: calc(100vh - 140px);
    overflow: auto;
  }
  .selected-run-focus {
    min-width: 0;
  }
  .metric-card,
  .panel {
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
  }
  .metric-label,
  .panel-title,
  .report-label,
  .detail-title {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .retrospective-rail {
    border-color: ${unsafeCSS(colors.accent)}55;
    background: ${unsafeCSS(colors.accent)}08;
  }
  .retro-what,
  .retro-copy,
  .retro-effect span {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
  }
  .retro-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .retro-details {
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .retro-details summary {
    cursor: pointer;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
  }
  .retro-effects {
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .retro-effect {
    display: grid;
    gap: 3px;
  }
  .retro-action-row {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .metric-value {
    margin-top: 4px;
    font-weight: 700;
    font-size: 13px;
  }
  .comparison-panel {
    margin-bottom: ${unsafeCSS(spacing.lg)};
    border-color: ${unsafeCSS(colors.accent)}44;
  }
  .comparison-head {
    display: flex;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    align-items: flex-start;
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .comparison-head-actions {
    display: flex;
    flex-wrap: wrap;
    gap: ${unsafeCSS(spacing.sm)};
    justify-content: flex-end;
  }
  .comparison-subtitle {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    margin-top: 4px;
    line-height: 1.4;
  }
  .comparison-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }
  .comparison-card {
    text-align: left;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    color: inherit;
    font-family: inherit;
    padding: ${unsafeCSS(spacing.sm)};
    cursor: pointer;
  }
  .comparison-card.selected {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}11;
  }
  .comparison-card.terminal-alert {
    border-color: var(--run-status-color);
    border-left: 3px solid var(--run-status-color);
    background: linear-gradient(90deg, var(--run-status-bg), ${unsafeCSS(colors.bgSurface)} 45%);
  }
  .comparison-card.terminal-alert.selected {
    border-color: ${unsafeCSS(colors.accent)};
    border-left-color: var(--run-status-color);
  }
  .comparison-card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .comparison-label {
    font-weight: 700;
    font-size: 12px;
    color: ${unsafeCSS(colors.textPrimary)};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .comparison-meta {
    margin-top: 5px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .comparison-output {
    margin-top: 8px;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 12px;
    line-height: 1.35;
  }
  .comparison-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 10px;
  }
  .comparison-facts span {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: 999px;
    padding: 2px 7px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .comparison-preview {
    margin-top: 10px;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    line-height: 1.4;
    border-left: 2px solid ${unsafeCSS(colors.textMuted)}33;
    padding-left: 8px;
  }
  .comparison-actions {
    display: flex;
    gap: 10px;
    margin-top: 10px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .comparison-actions a,
  .comparison-actions span {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
  }
  .output-compare-panel {
    margin-bottom: ${unsafeCSS(spacing.lg)};
    border-color: ${unsafeCSS(colors.accent)}55;
  }
  .output-compare-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 0.8fr) minmax(0, 1fr);
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .output-run-card,
  .output-delta-card {
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    min-width: 0;
  }
  .output-delta-card {
    border-color: ${unsafeCSS(colors.accent)}44;
    background: ${unsafeCSS(colors.accent)}0d;
  }
  .output-run-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    font-weight: 700;
  }
  .output-run-subtitle {
    margin-top: 4px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .output-metrics {
    display: grid;
    gap: 7px;
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .output-metric {
    display: grid;
    grid-template-columns: minmax(90px, auto) 1fr;
    gap: 4px 10px;
    align-items: baseline;
  }
  .output-metric span {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .output-metric strong {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    word-break: break-word;
  }
  .output-metric small {
    grid-column: 2;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .output-note {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    line-height: 1.4;
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .eval-select {
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textPrimary)};
    padding: 6px 8px;
    font-family: inherit;
    font-size: 11px;
  }
  .eval-package-table {
    display: grid;
    gap: 6px;
    overflow: auto;
  }
  .eval-package-row {
    display: grid;
    grid-template-columns: minmax(150px, 1fr) minmax(210px, 1.3fr) 110px 145px 160px 115px 80px;
    gap: 8px;
    align-items: start;
    min-width: 980px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    font-size: 12px;
  }
  .eval-package-head {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 0;
    background: transparent;
    padding: 0;
  }
  .eval-package-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .eval-package-row small {
    display: block;
    margin-top: 4px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    line-height: 1.35;
  }
  .change-ledger {
    margin-bottom: ${unsafeCSS(spacing.lg)};
  }
  .raw-ledger-details {
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .raw-ledger-details summary {
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .iteration-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .iteration-summary div {
    background: ${unsafeCSS(colors.accent)}0d;
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    display: grid;
    gap: 3px;
    padding: ${unsafeCSS(spacing.sm)};
  }
  .iteration-summary strong {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 16px;
  }
  .iteration-summary small {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .ledger-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .ledger-metrics div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
  }
  .ledger-metrics strong {
    font-size: 12px;
  }
  .ledger-entries {
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .ledger-entry {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
  }
  .ledger-entry-main {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
  }
  .ledger-entry-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .diff-scope-chip {
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    padding: 2px 6px;
    white-space: nowrap;
  }
  .warn {
    color: ${unsafeCSS(colors.statusWarn)};
  }
`;
