import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const prAutomationStyles = css`
  :host {
    display: block;
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }
  section,
  .card {
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    margin: 8px 0;
    background: ${unsafeCSS(colors.bgCard)};
  }
  h2,
  h3,
  p {
    margin: 0 0 10px;
  }
  h2 {
    font-size: 15px;
  }
  h3 {
    font-size: 13px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 10px;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  label.check {
    display: flex;
    align-items: center;
  }
  input,
  select,
  textarea,
  button {
    font: inherit;
    font-size: 12px;
    color: inherit;
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: 4px;
    padding: 7px 9px;
    background: ${unsafeCSS(colors.bgSurface)};
  }
  input,
  select,
  textarea {
    min-width: 0;
    box-sizing: border-box;
    width: 100%;
  }
  input[type='checkbox'] {
    width: auto;
  }
  button {
    cursor: pointer;
  }
  button:hover,
  button[aria-selected='true'],
  button[aria-pressed='true'] {
    border-color: ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .primary {
    background: ${unsafeCSS(colors.accent)};
    color: white;
  }
  .primary:hover {
    color: white;
  }
  .muted {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 12px;
  }
  .error {
    color: ${unsafeCSS(colors.statusFail)};
    white-space: pre-wrap;
  }
  .attention {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  a {
    color: ${unsafeCSS(colors.accent)};
  }
  small {
    font-size: 11px;
  }
  details {
    margin: 10px 0;
  }
  summary {
    cursor: pointer;
    margin: 7px 0;
  }
  fieldset {
    min-width: 0;
    border: 0;
    padding: 0;
    margin: 10px 0;
  }
  legend {
    margin-bottom: 7px;
    font-size: 12px;
  }
  .slots {
    max-height: 150px;
    overflow: auto;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .actions {
    margin-top: 12px;
  }
  .spacer {
    flex: 1;
  }
  code {
    overflow-wrap: anywhere;
  }
`;
