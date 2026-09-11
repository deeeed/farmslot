import { css, unsafeCSS } from 'lit';

import { colors, fonts } from '../../styles/theme-tokens.js';

export const prWorkspaceStyles = css`
  .workspace-nav,
  .workspace-toolbar,
  .detail-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    flex-shrink: 0;
    border-bottom: 1px solid #303047;
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .workspace-nav button,
  .workspace-toolbar button,
  .detail-tabs button,
  .work-inventory-back {
    font: inherit;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
    padding: 8px 12px;
    color: ${unsafeCSS(colors.textPrimary)};
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid #62627a;
    border-radius: 5px;
    cursor: pointer;
  }
  button[aria-current='page'],
  button[aria-pressed='true'],
  button[aria-selected='true'] {
    border-color: ${unsafeCSS(colors.accentHover)};
    background: #29294d;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  button:focus-visible,
  a:focus-visible {
    outline: 2px solid ${unsafeCSS(colors.accentHover)};
    outline-offset: -2px;
  }
  .workspace-toolbar label {
    font: 12px ${unsafeCSS(fonts.mono)};
    color: ${unsafeCSS(colors.textSecondary)};
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .workspace {
    position: relative;
    flex: 1;
    display: flex;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .workspace .split-list {
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .workspace .split-detail {
    min-height: 0;
    overflow: auto;
    padding: 12px;
  }
  .workspace.management .split-list {
    display: none;
  }
  .workspace.management .split-detail {
    width: 100%;
  }
  .workspace.management pr-automation-panel {
    max-width: 1100px;
    margin: auto;
  }
  .workspace:not(.management) .split-detail {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 5;
    width: min(880px, 78%);
    box-sizing: border-box;
    border-left: 1px solid #62627a;
    box-shadow: -12px 0 32px #0008;
    overscroll-behavior: contain;
    animation: pr-detail-enter 160ms ease-out;
  }
  .workspace:not(.management):not(.has-selection) .split-detail {
    display: none;
  }
  @keyframes pr-detail-enter {
    from {
      transform: translateX(32px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .workspace:not(.management) .split-detail {
      animation: none;
    }
  }
  .list-row {
    display: grid;
    gap: 8px;
    align-items: center;
    cursor: pointer;
    font-family: ${unsafeCSS(fonts.mono)};
    color: ${unsafeCSS(colors.textSecondary)};
    width: 100%;
    text-align: left;
    border: 0;
    border-bottom: 1px solid #303047;
    border-left: 3px solid transparent;
    background: transparent;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 12px 10px;
    font-size: 12px;
  }
  .list-row:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }
  .list-row.selected {
    background: ${unsafeCSS(colors.accent)}14;
    color: ${unsafeCSS(colors.textPrimary)};
    border-left-color: ${unsafeCSS(colors.accentHover)};
  }
  .list-row-main {
    display: grid;
    gap: 5px;
    min-width: 0;
  }
  .list-row .pr-num {
    font-weight: 600;
    color: ${unsafeCSS(colors.accentHover)};
    overflow-wrap: anywhere;
  }
  .list-row .pr-title {
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.35;
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 13px;
  }
  .pr-author {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .list-row .rec-chip {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid;
    white-space: normal;
    max-width: 105px;
    line-height: 1.4;
  }
  .pr-row-statuses {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
    align-items: center;
    max-width: 340px;
    text-align: right;
  }
  .pr-row-statuses .pr-author {
    flex-basis: 100%;
    order: 3;
  }
  .pr-row-statuses .rec-chip {
    max-width: none;
  }
  .review-badge {
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
  }
  .review-tone-warn {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .review-tone-fail {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .review-tone-ok {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .review-tone-muted {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .review-status-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    padding: 10px 0;
    font-size: 12px;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .review-status-summary p {
    flex-basis: 100%;
    margin: 0;
    line-height: 1.5;
  }
  .review-status-summary button {
    font: inherit;
    color: ${unsafeCSS(colors.textPrimary)};
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid #62627a;
    border-radius: 4px;
    padding: 6px 8px;
    cursor: pointer;
  }
  @media (max-width: 760px) {
    .pr-row-statuses {
      grid-column: 1 / -1;
      justify-content: flex-start;
      text-align: left;
      max-width: none;
    }
  }
  .detail-header {
    position: sticky;
    top: -12px;
    z-index: 3;
    padding-top: 12px;
    background: ${unsafeCSS(colors.bgBase)};
    margin-bottom: 12px;
  }
  .detail-header .pr-count {
    margin: 0 0 8px;
  }
  .detail-header h2 {
    margin: 8px 0 6px;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    color: ${unsafeCSS(colors.textPrimary)};
    font: 600 15px ${unsafeCSS(fonts.mono)};
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .detail-tabs {
    padding-left: 0;
    padding-right: 0;
    background: transparent;
  }
  .pr-count,
  .pr-scope,
  .refresh-ago,
  .list-toolbar-label {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .split-detail a {
    color: ${unsafeCSS(colors.accentHover)};
  }
  .work-inventory-back {
    display: inline-block;
    margin-bottom: 8px;
  }
  @media (max-width: 760px) {
    .detail-header {
      position: static;
    }
    .workspace-toolbar.detail-active {
      display: none;
    }
    .board-header .pr-scope,
    .board-header .refresh-ago {
      display: none;
    }
    .workspace:not(.management) .split-list {
      width: 100%;
      flex: 1;
    }
    .workspace:not(.management):not(.has-selection) .split-detail {
      display: none;
    }
    .workspace:not(.management).has-selection .split-list {
      visibility: hidden;
    }
    .workspace:not(.management).has-selection .split-detail {
      display: block;
      width: 100%;
    }
    .workspace-nav button,
    .workspace-toolbar button,
    .detail-tabs button,
    .work-inventory-back {
      min-height: 40px;
    }
    .board-header {
      padding: 10px;
      gap: 8px;
    }
    .workspace-toolbar {
      padding: 8px;
    }
    .list-row {
      display: grid;
      gap: 8px;
      align-items: center;
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      color: ${unsafeCSS(colors.textSecondary)};
      min-height: 64px;
    }
  }
`;
