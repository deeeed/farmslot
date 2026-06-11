import { html } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const configPanelLoadingStyle = `padding: 40px; text-align: center; color: ${colors.textMuted}; font-family: ${fonts.mono}`;

export function renderConfigPanelStyles() {
  return html`<style>
    config-panel {
      display: flex;
      height: 100%;
      overflow: hidden;
      font-family: ${fonts.mono};
    }

    /* Sidebar */
    config-panel .cp-sidebar {
      width: 200px;
      flex-shrink: 0;
      border-right: 1px solid ${colors.bgCard};
      overflow-y: auto;
      padding: ${spacing.md};
    }

    config-panel .cp-sidebar-section {
      margin-bottom: ${spacing.lg};
    }

    config-panel .cp-sidebar-title {
      font-size: ${fonts.sizeXs};
      color: ${colors.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: ${spacing.sm} ${spacing.md};
    }

    config-panel .cp-sidebar-item {
      display: flex;
      align-items: center;
      gap: ${spacing.sm};
      width: 100%;
      padding: 6px ${spacing.md};
      border: none;
      background: transparent;
      color: ${colors.textSecondary};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeSm};
      cursor: pointer;
      border-radius: ${radii.sm};
      transition: background 0.15s;
      text-align: left;
    }

    config-panel .cp-sidebar-item:hover {
      background: ${colors.bgCard};
    }

    config-panel .cp-sidebar-item.active {
      background: ${colors.accent}22;
      color: ${colors.accent};
    }

    config-panel .cp-item-icon {
      color: ${colors.textMuted};
      font-weight: 700;
      width: 14px;
      text-align: center;
    }

    config-panel .cp-item-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    config-panel .cp-item-badge {
      font-size: ${fonts.sizeXs};
      color: ${colors.textMuted};
      background: ${colors.bgCard};
      padding: 1px 5px;
      border-radius: 8px;
    }

    /* Content area */
    config-panel .cp-content {
      flex: 1;
      overflow-y: auto;
      padding: ${spacing.lg};
      min-width: 0;
    }

    config-panel .cp-empty {
      color: ${colors.textMuted};
      font-size: ${fonts.sizeSm};
      padding: ${spacing.xxl};
      text-align: center;
    }

    /* Pool header */
    config-panel .cp-pool-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: ${spacing.lg};
    }

    config-panel .cp-pool-header h3 {
      margin: 0;
      font-size: ${fonts.sizeLg};
      color: ${colors.textPrimary};
    }

    config-panel .cp-action-btn {
      padding: 4px 12px;
      border-radius: ${radii.sm};
      border: 1px solid ${colors.accent};
      background: transparent;
      color: ${colors.accent};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeXs};
      cursor: pointer;
      transition: background 0.15s;
    }

    config-panel .cp-action-btn:hover {
      background: ${colors.accent}22;
    }

    config-panel .cp-action-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    config-panel .cp-action-btn.secondary {
      border-color: ${colors.textMuted};
      color: ${colors.textMuted};
    }

    config-panel .cp-action-btn.secondary:hover {
      background: ${colors.bgCard};
    }

    config-panel .cp-editor-actions {
      display: flex;
      align-items: center;
      gap: ${spacing.md};
    }

    config-panel .cp-unsaved {
      font-size: ${fonts.sizeXs};
      color: ${colors.statusWarn};
    }

    /* Pool info rows */
    config-panel .cp-pool-info {
      margin-bottom: ${spacing.lg};
    }

    config-panel .cp-info-row {
      display: flex;
      gap: ${spacing.md};
      padding: 4px 0;
      border-bottom: 1px solid ${colors.bgCard}11;
      font-size: ${fonts.sizeSm};
    }

    config-panel .cp-info-label {
      width: 120px;
      flex-shrink: 0;
      color: ${colors.textMuted};
    }

    config-panel .cp-info-value {
      color: ${colors.textPrimary};
      word-break: break-all;
    }

    config-panel .cp-hook-value {
      font-size: ${fonts.sizeXs};
      color: ${colors.textSecondary};
    }

    /* Slot table */
    config-panel .cp-slot-table {
      width: 100%;
      border-collapse: collapse;
      font-size: ${fonts.sizeSm};
    }

    config-panel .cp-slot-table th {
      text-align: left;
      color: ${colors.textMuted};
      font-weight: 600;
      padding: ${spacing.sm} ${spacing.md};
      border-bottom: 1px solid ${colors.bgCard};
      font-size: ${fonts.sizeXs};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    config-panel .cp-slot-table td {
      padding: ${spacing.sm} ${spacing.md};
      border-bottom: 1px solid ${colors.bgCard}44;
      color: ${colors.textSecondary};
    }

    config-panel .cp-slot-link {
      color: ${colors.accent};
      cursor: pointer;
      text-decoration: none;
    }

    config-panel .cp-slot-link:hover {
      text-decoration: underline;
    }

    config-panel .cp-resources-cell {
      font-size: ${fonts.sizeXs};
      color: ${colors.textMuted};
    }

    /* Section */
    config-panel .cp-section {
      margin-bottom: ${spacing.lg};
    }

    config-panel .cp-section-title {
      font-size: ${fonts.sizeXs};
      color: ${colors.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: ${spacing.sm};
      padding-bottom: ${spacing.sm};
      border-bottom: 1px solid ${colors.bgCard};
    }

    /* CI checks */
    config-panel .cp-ci-checks {
      display: flex;
      flex-wrap: wrap;
      gap: ${spacing.sm};
    }

    config-panel .cp-ci-check {
      font-size: ${fonts.sizeXs};
      padding: 2px 8px;
      border-radius: ${radii.sm};
      background: ${colors.bgCard};
      color: ${colors.textSecondary};
    }

    config-panel .cp-auto-card {
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.md};
      background: ${colors.bgSurface};
      padding: ${spacing.md};
    }

    config-panel .cp-auto-card-head {
      display: flex;
      justify-content: space-between;
      gap: ${spacing.md};
      align-items: flex-start;
      margin-bottom: ${spacing.md};
    }

    config-panel .cp-auto-title {
      color: ${colors.textPrimary};
      font-size: ${fonts.sizeSm};
      font-weight: 700;
    }

    config-panel .cp-auto-subtitle {
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
      margin-top: 4px;
    }

    config-panel .cp-auto-summary {
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      background: ${colors.bgInput};
      padding: ${spacing.sm} ${spacing.md};
      margin-bottom: ${spacing.md};
    }

    config-panel .cp-auto-summary-title {
      color: ${colors.textPrimary};
      font-size: ${fonts.sizeXs};
      font-weight: 700;
      margin-bottom: 3px;
    }

    config-panel .cp-auto-summary-detail {
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
      line-height: 1.45;
    }

    config-panel .cp-preset-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: ${spacing.sm};
      margin-bottom: ${spacing.md};
    }

    config-panel .cp-preset-btn {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      border: 1px solid ${colors.accent}55;
      border-radius: ${radii.sm};
      background: ${colors.accent}11;
      color: ${colors.textPrimary};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeXs};
      padding: 7px 9px;
      cursor: pointer;
      text-align: left;
    }

    config-panel .cp-preset-btn:hover {
      border-color: ${colors.accent};
      background: ${colors.accent}22;
    }

    config-panel .cp-preset-btn.muted {
      border-color: ${colors.bgCard};
      background: transparent;
    }

    config-panel .cp-preset-btn span {
      color: ${colors.textMuted};
      font-size: 10px;
    }

    config-panel .cp-form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: ${spacing.md};
      color: ${colors.textSecondary};
      font-size: ${fonts.sizeXs};
    }

    config-panel .cp-form-grid label,
    config-panel .cp-switch-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    config-panel .cp-form-grid .cp-wide {
      grid-column: 1 / -1;
    }

    config-panel .cp-switch-row {
      flex-direction: row;
      align-items: center;
      gap: ${spacing.sm};
      min-height: 36px;
      padding: 8px 10px;
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      background: ${colors.bgInput};
      color: ${colors.textSecondary};
      font-size: ${fonts.sizeXs};
      cursor: pointer;
      user-select: none;
    }

    config-panel .cp-switch-row:hover {
      border-color: ${colors.accent}77;
      color: ${colors.textPrimary};
    }

    config-panel .cp-switch-row input[type='checkbox'] {
      width: 18px;
      height: 18px;
      margin: 0;
      accent-color: ${colors.accent};
      cursor: pointer;
    }

    config-panel .cp-input {
      background: ${colors.bgInput};
      color: ${colors.textPrimary};
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeXs};
      padding: 6px 8px;
      outline: none;
    }

    config-panel .cp-input:focus {
      border-color: ${colors.accent}77;
    }

    config-panel .cp-field-hint {
      color: ${colors.textMuted};
      font-size: 10px;
      line-height: 1.35;
    }

    config-panel .cp-auto-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: ${spacing.md};
      margin-top: ${spacing.md};
    }

    /* Tab group */
    config-panel .tab-group {
      display: flex;
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      overflow: hidden;
    }

    config-panel .tab-btn {
      padding: 4px 12px;
      border: none;
      background: transparent;
      color: ${colors.textMuted};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeXs};
      cursor: pointer;
    }

    config-panel .tab-btn.active {
      background: ${colors.bgCard};
      color: ${colors.textPrimary};
    }

    config-panel .cp-learnings-card {
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.md};
      background: ${colors.bgSurface};
      padding: ${spacing.md};
    }

    config-panel .cp-learnings-head {
      display: flex;
      justify-content: space-between;
      gap: ${spacing.md};
      align-items: flex-start;
      margin-bottom: ${spacing.md};
    }

    config-panel .cp-learnings-title {
      color: ${colors.textPrimary};
      font-size: ${fonts.sizeSm};
      font-weight: 700;
    }

    config-panel .cp-learnings-subtitle,
    config-panel .cp-learnings-meta {
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
      margin-top: 4px;
    }

    config-panel .cp-learnings-subtitle code {
      color: ${colors.textSecondary};
      background: ${colors.bgInput};
      border-radius: ${radii.sm};
      padding: 1px 4px;
    }

    config-panel .cp-learnings-body {
      margin-top: ${spacing.md};
      max-height: calc(100vh - 260px);
      overflow: auto;
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      background: ${colors.bgInput};
      color: ${colors.textSecondary};
      padding: ${spacing.md};
      font-size: ${fonts.sizeSm};
      line-height: 1.55;
    }

    config-panel .cp-learnings-body h1,
    config-panel .cp-learnings-body h2,
    config-panel .cp-learnings-body h3 {
      color: ${colors.textPrimary};
    }

    config-panel .cp-learnings-body code {
      background: ${colors.bgCard};
      border-radius: ${radii.sm};
      padding: 1px 4px;
    }

    config-panel .cp-learnings-body pre {
      overflow: auto;
      background: ${colors.bgCard};
      border-radius: ${radii.sm};
      padding: ${spacing.sm};
    }

    /* Template container */
    config-panel .cp-template-container {
      height: calc(100% - 50px);
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.md};
      overflow: hidden;
    }

    /* JSON editor */
    config-panel .cp-json-editor {
      width: 100%;
      height: calc(100% - 80px);
      min-height: 300px;
      background: ${colors.bgSurface};
      color: ${colors.textPrimary};
      border: 1px solid ${colors.bgCard};
      border-radius: ${radii.sm};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeSm};
      padding: ${spacing.md};
      resize: none;
      outline: none;
      tab-size: 2;
      line-height: 1.5;
    }

    config-panel .cp-json-editor:focus {
      border-color: ${colors.accent}55;
    }

    config-panel .cp-editor-error {
      color: ${colors.statusFail};
      font-size: ${fonts.sizeXs};
      padding: ${spacing.sm} 0;
      margin-bottom: ${spacing.sm};
    }
  </style>`;
}
