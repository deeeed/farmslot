import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const runListStyles = css`
  :host {
    display: block;
    height: 100%;
    overflow: auto;
    padding: ${unsafeCSS(spacing.lg)};
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  h2 {
    margin: 0;
    font-size: ${unsafeCSS(fonts.sizeLg)};
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .count {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
  }
  .rehydrating-banner {
    color: ${unsafeCSS(colors.statusWarn)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
  }
  .queue-preview {
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .tab {
    padding: 4px 10px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .tab:hover {
    background: ${unsafeCSS(colors.bgCard)};
  }
  .tab.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
  }
  .new-run-btn {
    margin-left: auto;
    padding: 5px 14px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    background: transparent;
    color: ${unsafeCSS(colors.accent)};
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .new-run-btn:hover {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .manage-btn {
    padding: 5px 14px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}66;
    background: transparent;
    color: ${unsafeCSS(colors.statusWarn)};
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .manage-btn.active {
    background: ${unsafeCSS(colors.statusWarn)}22;
  }
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: ${unsafeCSS(spacing.md)};
    flex-wrap: wrap;
  }
  .filter-label {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    margin-right: 2px;
  }
  .pill {
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .pill:hover {
    border-color: ${unsafeCSS(colors.textMuted)}88;
  }
  .pill.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}44;
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: ${unsafeCSS(spacing.md)};
    flex-wrap: wrap;
  }
  .tag-input,
  .search-input {
    flex: 1;
    min-width: 180px;
    max-width: 320px;
    padding: 5px 10px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }
  .tag-input::placeholder,
  .search-input::placeholder {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .tag-input:focus,
  .search-input:focus {
    border-color: ${unsafeCSS(colors.accent)}66;
  }
  .filter-select {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: inherit;
    font-size: 11px;
    outline: none;
    cursor: pointer;
  }
  .filter-select:focus {
    border-color: ${unsafeCSS(colors.accent)}66;
  }
  .result-count {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    margin-left: auto;
  }
  .analytics-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .analytics-card {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgCard)};
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .analytics-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    font-weight: 700;
  }
  .analytics-line {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .analytics-note {
    color: ${unsafeCSS(colors.statusWarn)};
    font-size: 10px;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .readiness-badge {
    border: 1px solid var(--readiness-color, ${unsafeCSS(colors.textMuted)});
    color: var(--readiness-color, ${unsafeCSS(colors.textMuted)});
    background: transparent;
  }
  .actions-bar {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: ${unsafeCSS(spacing.md)};
    padding: 6px 10px;
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: 4px;
    position: sticky;
    top: 0;
    z-index: 2;
    border: 1px solid ${unsafeCSS(colors.accent)}22;
  }
  .actions-bar span {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
  }
  .actions-bar.manage {
    background: linear-gradient(
      90deg,
      ${unsafeCSS(colors.statusWarn)}14,
      ${unsafeCSS(colors.bgCard)}
    );
  }
  .action-secondary {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: transparent;
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .action-secondary:hover {
    background: ${unsafeCSS(colors.bgSidebar)};
  }
  .action-btn {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.statusFail)}66;
    background: transparent;
    color: ${unsafeCSS(colors.statusFail)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .action-btn:hover {
    background: ${unsafeCSS(colors.statusFail)}22;
  }
  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .action-btn.cleanup {
    border-color: ${unsafeCSS(colors.statusWarn)}66;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .action-btn.cleanup:hover {
    background: ${unsafeCSS(colors.statusWarn)}22;
  }
  .action-btn.compare {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
  }
  .action-btn.compare:hover {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .outcome-badge {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
  }
  .grade-badge {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .empty {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    padding: ${unsafeCSS(spacing.xl)} 0;
    text-align: center;
  }
  .work-inventory-table {
    min-width: 1100px;
  }
  .work-inventory-head,
  .work-inventory-row.run-card {
    display: grid;
    gap: 6px;
    grid-template-columns: var(
      --work-inventory-columns,
      100px 58px minmax(100px, 140px) 110px 120px 140px 86px minmax(140px, 1fr)
    );
    align-items: center;
  }
  .run-pipeline-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .run-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 11px;
    font-weight: 650;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pipeline-label {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-row-affordances {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    min-width: 0;
  }
  .run-row-affordances .step-detail {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 10px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-row-affordances .inline-action {
    background: transparent;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}66;
    border-radius: 3px;
    color: ${unsafeCSS(colors.statusWarn)};
    cursor: pointer;
    font: inherit;
    font-size: 10px;
    padding: 1px 6px;
  }
  .run-row-affordances .ext-link {
    color: ${unsafeCSS(colors.accent)};
    font-size: 10px;
  }
  .run-card {
    align-items: start;
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    margin-top: 3px;
    min-height: 40px;
    padding: 5px 8px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .run-card:hover {
    background: ${unsafeCSS(colors.bgSidebar)};
  }
  .run-card.manage-mode {
    cursor: default;
  }
  .work-inventory-layout.split {
    grid-template-columns: minmax(420px, 0.9fr) minmax(0, 1.1fr);
  }
  .run-list-detail {
    display: block;
    min-width: 0;
  }
  .run-flow-cell {
    align-items: center;
    display: flex;
  }
  .run-project {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 11px;
    font-weight: 600;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .family-section {
    margin-bottom: ${unsafeCSS(spacing.md)};
  }
  .family-header {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
    margin-bottom: 6px;
    padding: 6px 10px;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .family-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 700;
  }
  .family-link {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    cursor: pointer;
  }
  .family-link:hover {
    text-decoration: underline;
  }
  .family-summary-row {
    padding: 0 10px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .family-summary-text {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    line-height: 1.35;
  }
  .family-summary-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .run-card.selected {
    outline: 2px solid ${unsafeCSS(colors.accent)}66;
    background: ${unsafeCSS(colors.accent)}12;
  }
  .selector-cell {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
  }
  .selector-btn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textMuted)};
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .selector-btn:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
  }
  .selector-btn.selected {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
  }
  .selector-btn.disabled {
    opacity: 0.5;
  }
  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .status-badge {
    border: 1px solid var(--status-color, ${unsafeCSS(colors.textMuted)});
    color: var(--status-color, ${unsafeCSS(colors.textMuted)});
    background: transparent;
  }
  .evidence-signals {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .evidence-signal {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-decoration: none;
    border: 1px solid ${unsafeCSS(colors.statusOk)}66;
    color: ${unsafeCSS(colors.statusOk)};
    background: ${unsafeCSS(colors.statusOk)}12;
  }
  .evidence-signal:hover {
    background: ${unsafeCSS(colors.statusOk)}22;
  }
  .evidence-signal.video {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}12;
  }
  .evidence-signal.video:hover {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .step-detail {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .info-top {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .run-id {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
  }
  .ticket {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    font-weight: 600;
  }
  .ext-link {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-decoration: none;
    color: ${unsafeCSS(colors.accent)};
    border: 1px solid ${unsafeCSS(colors.accent)};
  }
  .ext-link:hover {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .summary {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .run-summary-line {
    align-items: center;
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  .run-summary-line .summary {
    flex: 1;
  }
  .run-summary-line .run-id {
    flex: none;
  }
  .pr-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    font-weight: 600;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.35;
  }
  .info-bottom {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .meta-badges {
    align-items: center;
    display: flex;
    gap: 4px;
  }
  .slot-id {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
    max-width: 145px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .run-state {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .inline-action {
    border: 1px solid ${unsafeCSS(colors.statusWarn)}66;
    border-radius: 3px;
    background: transparent;
    color: ${unsafeCSS(colors.statusWarn)};
    cursor: pointer;
    font: inherit;
    font-size: 9px;
    line-height: 1.2;
    padding: 2px 5px;
  }
  .inline-action:hover {
    background: ${unsafeCSS(colors.statusWarn)}12;
  }
  .state-badges {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .cleanup-preview {
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    margin-bottom: ${unsafeCSS(spacing.md)};
    font-size: 12px;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .cleanup-preview h4 {
    margin: 0 0 8px 0;
    font-size: 13px;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .cleanup-preview ul {
    margin: 4px 0;
    padding-left: 16px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
  }
  .cleanup-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: 8px;
  }
  .confirm-btn {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.statusFail)}66;
    background: ${unsafeCSS(colors.statusFail)}22;
    color: ${unsafeCSS(colors.statusFail)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .cancel-btn {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
`;
