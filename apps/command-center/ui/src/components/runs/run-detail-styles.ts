import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const runDetailStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: ${unsafeCSS(spacing.lg)};
    padding-bottom: 0;
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
  .header {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    margin-bottom: ${unsafeCSS(spacing.lg)};
  }
  h2 {
    margin: 0;
    font-size: ${unsafeCSS(fonts.sizeLg)};
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .header-summary {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 13px;
    font-weight: 600;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .status-badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
  }
  .external-links {
    display: flex;
    gap: 6px;
    margin-left: 4px;
  }
  .ext-link {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-decoration: none;
    color: ${unsafeCSS(colors.accent)};
    border: 1px solid ${unsafeCSS(colors.accent)};
    transition: background 0.15s;
  }
  .ext-link:hover {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: ${unsafeCSS(spacing.lg)};
    font-size: 12px;
  }
  .meta-item {
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
  }
  .meta-label {
    color: ${unsafeCSS(colors.textMuted)};
    margin-bottom: 2px;
  }
  .meta-value {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .model-drift {
    display: inline-block;
    margin-left: 6px;
    padding: 0 6px;
    background: ${unsafeCSS(colors.statusWarn)};
    color: #000;
    border-radius: ${unsafeCSS(radii.sm)};
    font-size: 11px;
    font-weight: 600;
    cursor: help;
  }
  .review-chain {
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: ${unsafeCSS(radii.md)};
    margin-bottom: ${unsafeCSS(spacing.lg)};
    padding: ${unsafeCSS(spacing.md)};
  }
  .review-chain-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    font-weight: 700;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .review-chain-grid {
    display: grid;
    gap: 4px;
  }
  .review-chain-row {
    align-items: center;
    color: ${unsafeCSS(colors.textSecondary)};
    display: grid;
    font-size: 11px;
    gap: ${unsafeCSS(spacing.sm)};
    grid-template-columns: 34px minmax(120px, 0.8fr) minmax(150px, 1fr) minmax(150px, 1fr) auto;
    padding: 5px 6px;
    text-decoration: none;
  }
  .review-chain-row:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }
  .review-chain-generation {
    color: ${unsafeCSS(colors.accent)};
    font-weight: 700;
  }
  .review-chain-session {
    border: 1px solid ${unsafeCSS(colors.textMuted)}55;
    border-radius: 999px;
    padding: 1px 6px;
  }
  .review-chain-session.resumed {
    border-color: ${unsafeCSS(colors.statusOk)}88;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .review-chain-session.fresh {
    border-color: ${unsafeCSS(colors.accent)}88;
    color: ${unsafeCSS(colors.accent)};
  }
  .review-chain-session.fallback-fresh {
    border-color: ${unsafeCSS(colors.statusWarn)}88;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .review-chain-session.resume-unconfirmed {
    border-color: ${unsafeCSS(colors.statusFail)}88;
    color: ${unsafeCSS(colors.statusFail)};
  }
  .pipeline-section {
    margin-bottom: ${unsafeCSS(spacing.lg)};
    flex-shrink: 0;
  }
  .evidence-card {
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgCard)};
    padding: ${unsafeCSS(spacing.md)};
    margin-bottom: ${unsafeCSS(spacing.lg)};
    font-size: 12px;
  }
  .evidence-head {
    display: flex;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    align-items: flex-start;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .evidence-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 700;
    font-size: 13px;
  }
  .evidence-copy {
    color: ${unsafeCSS(colors.textMuted)};
    line-height: 1.5;
    margin-top: 3px;
  }
  .evidence-badge {
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    color: ${unsafeCSS(colors.accent)};
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 700;
  }
  .evidence-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .evidence-link {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
  }
  .evidence-link:hover {
    background: ${unsafeCSS(colors.accent)}16;
  }
  .evidence-empty {
    color: ${unsafeCSS(colors.textMuted)};
    padding-top: ${unsafeCSS(spacing.sm)};
  }
  .error-box {
    background: ${unsafeCSS(colors.statusFail)}15;
    border: 1px solid ${unsafeCSS(colors.statusFail)}44;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    margin-top: ${unsafeCSS(spacing.md)};
    font-size: 12px;
    color: ${unsafeCSS(colors.statusFail)};
  }
  .empty {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    padding: ${unsafeCSS(spacing.xl)} 0;
    text-align: center;
  }
  .grade-card {
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    margin-bottom: ${unsafeCSS(spacing.md)};
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    font-size: 12px;
  }
  .grade-difficulty {
    padding: 3px 10px;
    border-radius: 4px;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
  }
  .grade-rationale {
    color: ${unsafeCSS(colors.textMuted)};
    flex: 1;
  }
  .gate-section {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}44;
    border-radius: ${unsafeCSS(radii.md)};
    overflow: hidden;
  }
  .gate-section.ready-gate {
    flex: 0 0 auto;
  }
  .gate-header {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
    background: ${unsafeCSS(colors.statusWarn)}12;
    border-bottom: 1px solid ${unsafeCSS(colors.statusWarn)}22;
  }
  .gate-icon {
    font-size: 18px;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .gate-title {
    font-size: 13px;
    font-weight: 600;
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .gate-subtitle {
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .gate-slot-link {
    margin-left: auto;
    padding: 5px 14px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    background: transparent;
    color: ${unsafeCSS(colors.accent)};
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
  }
  .gate-slot-link:hover {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .gate-workspace {
    flex: 1;
    min-height: 400px;
    overflow: hidden;
  }
  .gate-body {
    padding: ${unsafeCSS(spacing.lg)};
  }
  .gate-description {
    font-size: 13px;
    line-height: 1.6;
    color: ${unsafeCSS(colors.textPrimary)};
    max-height: 400px;
    overflow-y: auto;
    margin-bottom: ${unsafeCSS(spacing.lg)};
  }
  .gate-description h1,
  .gate-description h2,
  .gate-description h3 {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .gate-description strong {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .gate-description code {
    background: ${unsafeCSS(colors.bgSurface)};
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 12px;
  }
  .gate-description pre {
    background: ${unsafeCSS(colors.bgSurface)};
    padding: ${unsafeCSS(spacing.sm)};
    border-radius: ${unsafeCSS(radii.sm)};
    overflow-x: auto;
    font-size: 12px;
  }
  .gate-description ol,
  .gate-description ul {
    padding-left: 20px;
  }
  .gate-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.md)};
    justify-content: flex-end;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .gate-action-cell {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    max-width: 280px;
  }
  .gate-action-help {
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
    line-height: 1.35;
    text-align: left;
  }
  .gate-action-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 13px;
    font-weight: 600;
    padding: 8px 24px;
    border-radius: ${unsafeCSS(radii.md)};
    border: 1px solid;
    background: transparent;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .gate-action-btn:hover {
    opacity: 0.85;
  }
  @keyframes gate-pulse {
    0% {
      opacity: 1;
    }
    100% {
      opacity: 0.7;
    }
  }
  .gate-confirming {
    background: ${unsafeCSS(colors.statusWarn)}22 !important;
    border-color: ${unsafeCSS(colors.statusWarn)} !important;
    color: ${unsafeCSS(colors.statusWarn)} !important;
    animation: gate-pulse 0.6s ease-in-out infinite alternate;
  }
  .terminal-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    cursor: pointer;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .terminal-toggle:hover {
    color: ${unsafeCSS(colors.textPrimary)};
    border-color: ${unsafeCSS(colors.textPrimary)}44;
  }
  .terminal-toggle.active {
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}44;
  }
  .terminal-section {
    flex: 1;
    min-height: 300px;
    max-height: 500px;
    margin-bottom: ${unsafeCSS(spacing.md)};
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    overflow: hidden;
  }
  .rehydrating-banner {
    color: ${unsafeCSS(colors.statusWarn)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .gate-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Collision decision — description chip links */
  .cdesc-line {
    font-size: 12px;
    color: ${unsafeCSS(colors.textPrimary)};
    padding: 4px 0;
    line-height: 1.6;
  }
  .cdesc-slug {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .cdesc-dir {
    display: inline-block;
    padding: 1px 6px;
    margin: 0 2px;
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: 3px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
  }
  .cdesc-dir.unlinked {
    color: ${unsafeCSS(colors.textMuted)};
    cursor: default;
  }
  /* Only the linked variant should hint at interactivity — unlinked chips must not flash. */
  .cdesc-dir:not(.unlinked):hover {
    background: ${unsafeCSS(colors.bgSurface)};
    border-color: ${unsafeCSS(colors.accent + '44')};
  }

  /* Collision decision — prior-runs panel */
  .cpr-wrap {
    margin: 8px 0 12px;
  }
  .cpr-label {
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
    margin-bottom: 6px;
  }
  .cpr-row {
    display: grid;
    grid-template-columns: 84px minmax(180px, 1.4fr) minmax(140px, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.sm)};
    margin-bottom: 4px;
    text-decoration: none;
    color: inherit;
    font-size: 12px;
  }
  .cpr-row:hover {
    background: ${unsafeCSS(colors.bgSurface)};
    border-color: ${unsafeCSS(colors.accent + '44')};
  }
  .cpr-status {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    text-align: center;
    border: 1px solid currentColor;
  }
  .cpr-meta {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
  }
  .cpr-flow {
    font-weight: 600;
    font-size: 12px;
  }
  .cpr-id {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .cpr-time {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    white-space: nowrap;
    text-align: right;
  }
  .cpr-branch {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .cpr-error {
    color: ${unsafeCSS(colors.statusFail)};
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .cpr-grade {
    display: inline-block;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid ${unsafeCSS(colors.textMuted + '66')};
    color: ${unsafeCSS(colors.textMuted)};
    margin-left: 6px;
  }
  .cpr-pipeline-row {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .cpr-redirect {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: ${unsafeCSS(colors.accent + '22')};
    color: ${unsafeCSS(colors.accent)};
    margin-left: 6px;
  }
`;
