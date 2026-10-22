import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii } from '../../styles/theme-tokens.js';

export const reviewHistoryStyles = css`
  :host {
    display: block;
    color: ${unsafeCSS(colors.textPrimary)};
    font:
      13px system-ui,
      sans-serif;
  }
  section {
    padding: 16px;
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.lg)};
    background: ${unsafeCSS(colors.bgCard)};
  }
  .history-header,
  .round-heading,
  .finding-heading,
  .round-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .history-header {
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .history-header h3 {
    margin: 0;
    font-size: 15px;
  }
  .review-loop-meta,
  .round-meta {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 12px;
  }
  .timeline {
    border-left: 2px solid ${unsafeCSS(colors.bgCardHover)};
    margin-left: 6px;
    padding-left: 18px;
    display: grid;
    gap: 14px;
  }
  .review-history-round,
  .review-history-fix,
  .history-gate {
    position: relative;
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: 8px;
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .review-history-round::before,
  .review-history-fix::before,
  .history-gate::before {
    content: '';
    position: absolute;
    left: -25px;
    top: 21px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: ${unsafeCSS(colors.accent)};
  }
  .review-history-fix::before {
    background: ${unsafeCSS(colors.statusWarn)};
  }
  .review-history-fix {
    margin-right: 12px;
  }
  summary {
    min-height: 44px;
    cursor: pointer;
    padding: 12px;
  }
  summary > span {
    margin: 3px 0;
  }
  .round-heading {
    justify-content: space-between;
  }
  .round-meta {
    overflow-wrap: anywhere;
  }
  .round-meta code {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .review-history-body {
    display: grid;
    gap: 12px;
    padding: 0 12px 12px;
  }
  .chip {
    border-radius: 5px;
    padding: 3px 6px;
    background: ${unsafeCSS(colors.bgCard)};
    font-size: 11px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .verdict.ok,
  .resolved {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .verdict.warn,
  .severity,
  .history-warning {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .verdict.fail {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .review-loop-issue {
    padding: 12px;
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: 6px;
    display: grid;
    gap: 8px;
  }
  .finding-text {
    white-space: pre-wrap;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .finding-text p {
    margin: 4px 0 0;
  }
  button {
    min-height: 44px;
    padding: 8px 12px;
    background: transparent;
    color: ${unsafeCSS(colors.accent)};
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    text-align: left;
    overflow-wrap: anywhere;
  }
  button:disabled {
    color: ${unsafeCSS(colors.textMuted)};
    cursor: default;
  }
  .finding-location {
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .fix-files {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .history-gate {
    padding: 12px;
  }
  code-viewer {
    height: 420px;
    min-width: 0;
  }
  @media (max-width: 600px) {
    section {
      padding: 10px;
    }
    .timeline {
      padding-left: 13px;
    }
    .review-history-round::before,
    .review-history-fix::before,
    .history-gate::before {
      left: -20px;
    }
    .review-history-fix {
      margin-right: 0;
    }
  }
`;
