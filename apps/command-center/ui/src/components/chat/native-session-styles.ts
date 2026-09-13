import { css, unsafeCSS } from 'lit';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

export const nativeSessionStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
  }
  * {
    box-sizing: border-box;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: 4px;
    padding: 6px 9px;
  }
  button {
    cursor: pointer;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  summary:focus-visible {
    outline: 2px solid ${unsafeCSS(colors.accent)};
    outline-offset: 2px;
  }
  button:disabled,
  input:disabled,
  select:disabled,
  textarea:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.primary,
  button[aria-pressed='true'] {
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)};
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: ${unsafeCSS(spacing.sm)};
    border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
  }
  .bar select {
    max-width: min(480px, 70vw);
  }
  .meta {
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
    overflow-wrap: anywhere;
  }
  .identity {
    padding: 6px 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .status {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .status[data-state='idle'] {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .status[data-state='failed'] {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .status[data-state='closed'] {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .error {
    padding: 8px 10px;
    color: ${unsafeCSS(colors.statusFail)};
    overflow-wrap: anywhere;
  }
  .new-session {
    padding: 12px;
    overflow: auto;
    display: grid;
    gap: 12px;
  }
  label {
    display: grid;
    gap: 5px;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .layout {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: minmax(320px, 1fr) minmax(350px, 1fr);
    flex: 1;
    min-height: 0;
  }
  .layout.conversation-only {
    grid-template-columns: minmax(0, 1fr);
  }
  .conversation {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  native-workspace {
    border-left: 1px solid ${unsafeCSS(colors.bgCardHover)};
  }
  .timeline {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px;
  }
  article {
    margin: 0 0 14px;
    overflow-wrap: anywhere;
  }
  article.user {
    margin-left: 12%;
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: 6px;
    padding: 10px;
  }
  article.assistant {
    margin-right: 3%;
  }
  pre,
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    margin: 6px 0;
    font: inherit;
    line-height: 1.55;
  }
  details {
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: 4px;
    margin: 5px 0;
    padding: 8px;
  }
  summary {
    cursor: pointer;
  }
  details pre,
  .request pre {
    max-height: 240px;
    overflow: auto;
  }
  .composer {
    flex-shrink: 0;
    max-height: 70%;
    overflow-y: auto;
    padding: 10px;
    border-top: 1px solid ${unsafeCSS(colors.bgCardHover)};
    display: grid;
    gap: 8px;
  }
  .composer textarea {
    width: 100%;
    min-height: 65px;
    max-height: 180px;
    resize: vertical;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .requests {
    max-height: 40vh;
    overflow: auto;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .request {
    border: 1px solid ${unsafeCSS(colors.statusWarn)};
    padding: 10px;
    border-radius: 5px;
    margin: 5px 0;
  }
  .request h3 {
    font-size: inherit;
    margin: 0 0 8px;
  }
  fieldset {
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    margin: 8px 0;
  }
  fieldset label {
    display: flex;
    align-items: center;
    margin: 6px 0;
  }
  fieldset input[type='text'] {
    width: 100%;
  }
  .empty {
    padding: 24px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  @media (max-width: 1000px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .layout.workspace-visible .conversation {
      display: none;
    }
    .layout:not(.workspace-visible) native-workspace {
      display: none;
    }
    native-workspace {
      border-left: 0;
    }
  }
`;
