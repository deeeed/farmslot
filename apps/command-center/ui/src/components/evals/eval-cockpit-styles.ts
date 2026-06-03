import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const evalCockpitStyles = css`
  :host {
    display: block;
    height: 100%;
    min-height: 0;
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .eval-cockpit {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    padding: ${unsafeCSS(spacing.lg)};
    padding-bottom: calc(${unsafeCSS(spacing.lg)} + 32px);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    align-content: start;
  }
  .eval-hero,
  .eval-panel {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgCard)};
    padding: ${unsafeCSS(spacing.md)};
  }
  .eval-hero {
    display: flex;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    align-items: flex-start;
    border-color: ${unsafeCSS(colors.accent)}44;
  }
  .eyebrow {
    color: ${unsafeCSS(colors.accent)};
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 11px;
  }
  h2 {
    margin: 4px 0 8px;
    font-size: 20px;
  }
  p,
  .eval-muted,
  small {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    line-height: 1.4;
  }
  code {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .eval-actions,
  .eval-panel-head {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .eval-button {
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textPrimary)};
    padding: 7px 10px;
    font-family: inherit;
    cursor: pointer;
  }
  .eval-button.primary {
    border-color: ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
  }
  .eval-button:disabled,
  .link-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .eval-panel-title {
    font-weight: 700;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .eval-scroll-help {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    border: 1px dashed ${unsafeCSS(colors.textMuted)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 7px 9px;
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .term-panel {
    border-color: ${unsafeCSS(colors.accent)}33;
  }
  .term-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 8px;
  }
  .term {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 8px;
    background: ${unsafeCSS(colors.bgSurface)};
    display: grid;
    gap: 4px;
  }
  .term strong {
    font-size: 11px;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .term span {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    line-height: 1.35;
  }
  .boundary-note {
    margin-top: 10px;
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 10px;
    background: ${unsafeCSS(colors.accent)}0d;
  }
  .boundary-note ul {
    margin: 0;
    padding-left: 18px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    line-height: 1.5;
  }
  .eval-form-grid,
  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }
  label {
    display: grid;
    gap: 4px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  label.wide {
    grid-column: 1 / -1;
  }
  input,
  select {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgBase)};
    color: ${unsafeCSS(colors.textPrimary)};
    padding: 7px 8px;
    font-family: inherit;
    font-size: 12px;
  }
  .cap-row {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .cap-row label {
    width: 130px;
  }
  .cap-row.live {
    margin: 10px 0;
    align-items: center;
  }
  .active-cap {
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.accent)}0d;
    padding: 8px 10px;
    display: grid;
    gap: 2px;
    min-width: 120px;
  }
  .active-cap strong {
    color: ${unsafeCSS(colors.accent)};
    font-size: 16px;
  }
  .active-cap span {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .chip-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 10px 0;
  }
  .chip {
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    border-radius: 999px;
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textMuted)};
    padding: 5px 9px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .chip.active {
    border-color: ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}14;
  }
  .reference-summary-list {
    display: grid;
    gap: 8px;
    margin-top: 10px;
  }
  .reference-summary-card {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: flex-start;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .selected-reference-card {
    gap: ${unsafeCSS(spacing.md)};
  }
  .selected-reference-main {
    display: grid;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .selected-reference-actions {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .selected-reference-meta {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .reference-options {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgBase)};
    padding: 8px;
  }
  .reference-options summary {
    cursor: pointer;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    font-weight: 700;
  }
  .reference-options-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    margin-top: 8px;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    box-sizing: border-box;
  }
  .reference-modal {
    width: min(1480px, calc(100vw - 48px));
    max-height: calc(100vh - 48px);
    overflow: auto;
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgCard)};
    padding: ${unsafeCSS(spacing.md)};
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
  }
  .modal-head {
    display: flex;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    align-items: flex-start;
    position: sticky;
    top: 0;
    background: ${unsafeCSS(colors.bgCard)};
    z-index: 2;
    padding-bottom: 8px;
  }
  .reference-picker-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) minmax(280px, 0.75fr);
    gap: ${unsafeCSS(spacing.md)};
    align-items: start;
  }
  .reference-table-wrap {
    min-width: 0;
    overflow: auto;
    max-height: min(62vh, 680px);
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .reference-table {
    display: grid;
    grid-template-columns: minmax(300px, 1.5fr) 105px 74px minmax(150px, 0.8fr) 88px 110px 130px;
    gap: 8px;
    align-items: center;
    min-width: 980px;
  }
  .reference-head {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 8px;
    background: ${unsafeCSS(colors.bgBase)};
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid ${unsafeCSS(colors.textMuted)}22;
  }
  .reference-table-body {
    display: grid;
    gap: 0;
  }
  .sort-head {
    border: 0;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0;
    text-transform: inherit;
    letter-spacing: inherit;
  }
  .launch-table,
  .package-table {
    display: grid;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 4px;
    scrollbar-gutter: stable;
  }
  .case-row {
    gap: 8px;
    align-items: center;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    cursor: pointer;
  }
  .case-row.previewing {
    border-color: ${unsafeCSS(colors.accent)}77;
  }
  .case-row.disabled {
    opacity: 0.62;
  }
  .run-type-chip {
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    background: ${unsafeCSS(colors.accent)}14;
    color: ${unsafeCSS(colors.accent)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 3px 7px;
    font-size: 10px;
    font-weight: 700;
    text-align: center;
    letter-spacing: 0.04em;
  }
  .run-type-chip.fix-bug {
    border-color: ${unsafeCSS(colors.statusWarn)}66;
    background: ${unsafeCSS(colors.statusWarn)}16;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .run-type-chip.dev {
    border-color: ${unsafeCSS(colors.accent)}66;
    background: ${unsafeCSS(colors.accent)}16;
    color: ${unsafeCSS(colors.accent)};
  }
  .status-stack {
    display: grid;
    gap: 2px;
  }
  .status-stack small:first-child {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .add-reference {
    min-height: 32px;
    white-space: nowrap;
  }
  .case-preview,
  .manual-entry {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    display: grid;
    gap: 8px;
  }
  .manual-entry {
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .manual-toggle-row,
  .candidate-controls {
    display: flex;
    gap: 8px;
    align-items: center;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .preview-title {
    font-weight: 700;
    font-size: 13px;
  }
  .preview-link-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .preview-link {
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 5px 8px;
    background: ${unsafeCSS(colors.accent)}12;
    font-size: 11px;
  }
  .preview-stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(105px, 1fr));
    gap: 6px;
  }
  .preview-stat {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 7px;
    background: ${unsafeCSS(colors.bgBase)};
    display: grid;
    gap: 2px;
  }
  .preview-stat strong {
    font-size: 15px;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .preview-stat span {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .preview-stat small {
    font-size: 10px;
  }
  dl {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 4px 8px;
    margin: 0;
    font-size: 11px;
  }
  dt {
    color: ${unsafeCSS(colors.textMuted)};
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .badge {
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    color: ${unsafeCSS(colors.accent)};
    border-radius: 999px;
    padding: 3px 7px;
    font-size: 10px;
    text-align: center;
  }
  .muted-badge {
    border-color: ${unsafeCSS(colors.textMuted)}33;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .candidate-trial-summary {
    margin-top: 8px;
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 8px 10px;
    background: ${unsafeCSS(colors.accent)}0d;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 12px;
  }
  .candidate-card-list {
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .candidate-card {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgSurface)};
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .candidate-card.disabled {
    opacity: 0.62;
  }
  .candidate-card-head,
  .candidate-card-actions {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .candidate-card-title {
    font-size: 14px;
    font-weight: 700;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .candidate-advanced-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 8px;
  }
  .dispatch-like-block {
    display: grid;
    gap: 6px;
  }
  .choice-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .choice-chip {
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgBase)};
    color: ${unsafeCSS(colors.textMuted)};
    padding: 7px 10px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .choice-chip.active {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}18;
    color: ${unsafeCSS(colors.accent)};
  }
  .template-choice-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
  }
  .template-choice-button {
    text-align: left;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textSecondary)};
    padding: 10px 12px;
    font-family: inherit;
    cursor: pointer;
    display: grid;
    gap: 4px;
  }
  .template-choice-button span {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 700;
    font-size: 12px;
  }
  .template-choice-button small {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    line-height: 1.35;
  }
  .template-choice-button.active {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}18;
    box-shadow: 0 0 0 1px ${unsafeCSS(colors.accent)}22 inset;
  }
  .template-choice-button.active small {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .field-label {
    display: grid;
    gap: 5px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .start-ref-field {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 10px;
    background: ${unsafeCSS(colors.bgBase)};
    display: grid;
    gap: 8px;
  }
  .base-choice-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .base-choice-note {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    line-height: 1.4;
  }
  .candidate-template-details {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 9px 10px;
    background: ${unsafeCSS(colors.bgBase)};
  }
  .candidate-template-details summary {
    cursor: pointer;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 12px;
    font-weight: 700;
  }
  .candidate-template-details summary span {
    color: ${unsafeCSS(colors.textMuted)};
    font-weight: 400;
    margin-left: 8px;
  }
  .candidate-template-details[open] {
    display: grid;
    gap: 10px;
  }
  .advanced-help {
    margin: 0;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    line-height: 1.45;
  }
  .readonly-axis {
    display: block;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textSecondary)};
    padding: 8px;
    font-size: 11px;
    overflow-wrap: anywhere;
    text-transform: none;
    letter-spacing: 0;
  }
  .repeat-row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    text-transform: none;
    letter-spacing: 0;
  }
  .package-row {
    display: grid;
    grid-template-columns: minmax(160px, 1.1fr) minmax(190px, 1.2fr) 120px 150px 170px 120px 80px;
    gap: 8px;
    align-items: start;
    min-width: 980px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    font-size: 12px;
  }
  .launch-row {
    display: grid;
    grid-template-columns: minmax(170px, 1fr) 150px 110px 150px 180px 120px minmax(220px, 1.4fr);
    gap: 8px;
    align-items: start;
    min-width: 1120px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    font-size: 12px;
  }
  .package-head,
  .launch-head {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 0;
    background: transparent;
    padding: 0;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 8px;
    margin: 10px 0;
  }
  .metric {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 8px;
    background: ${unsafeCSS(colors.bgSurface)};
    display: grid;
    gap: 2px;
  }
  .metric strong {
    font-size: 15px;
  }
  .metric span {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .status-pill {
    display: inline-block;
    border: 1px solid ${unsafeCSS(colors.textMuted)}33;
    border-radius: 999px;
    padding: 3px 7px;
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .status-pill.final,
  .status-pill.deduped {
    border-color: ${unsafeCSS(colors.statusOk)}66;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .status-pill.running,
  .status-pill.launching,
  .status-pill.creating {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
  }
  .status-pill.error,
  .status-pill.failed {
    border-color: ${unsafeCSS(colors.statusFail)}66;
    color: ${unsafeCSS(colors.statusFail)};
  }
  .stack {
    display: grid;
    gap: 4px;
  }
  .launch-action-panel {
    border-color: ${unsafeCSS(colors.accent)}55;
    background: ${unsafeCSS(colors.accent)}08;
  }
  .launch-note {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 8px 10px;
    color: ${unsafeCSS(colors.textMuted)};
    background: ${unsafeCSS(colors.bgBase)};
    font-size: 11px;
  }
  .eval-status {
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.textSecondary)};
    background: ${unsafeCSS(colors.accent)}0d;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .eval-error {
    border: 1px solid ${unsafeCSS(colors.statusFail)}66;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.statusFail)};
    background: ${unsafeCSS(colors.statusFail)}0d;
    font-size: 12px;
  }
  .eval-error.slim {
    padding: 6px;
  }
  .warn-text {
    color: ${unsafeCSS(colors.statusWarn)};
    display: block;
    margin-top: 3px;
  }
  .empty-state {
    border: 1px dashed ${unsafeCSS(colors.textMuted)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.md)};
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 12px;
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .link-button {
    border: 0;
    background: transparent;
    color: ${unsafeCSS(colors.accent)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    padding: 7px 0;
    text-align: left;
  }
  a {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
  }
  @media (max-width: 960px) {
    .reference-picker-layout {
      grid-template-columns: 1fr;
    }
    .modal-backdrop {
      padding: 10px;
    }
    .reference-modal {
      width: calc(100vw - 20px);
      max-height: calc(100vh - 20px);
    }
  }
`;
