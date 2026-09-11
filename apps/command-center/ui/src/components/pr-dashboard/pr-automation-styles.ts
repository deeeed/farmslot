import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const prAutomationStyles = css`
  :host {
    display: block;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }
  section,
  .card {
    min-width: 0;
    box-sizing: border-box;
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
  .setup-help {
    font-size: 12px;
    line-height: 1.5;
  }
  .automation-management {
    color: ${unsafeCSS(colors.textPrimary)};
    overflow-wrap: anywhere;
  }
  .context-automation {
    color: ${unsafeCSS(colors.textPrimary)};
    overflow-wrap: anywhere;
  }
  .context-automation .muted {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .review-dispatch-link {
    display: inline-block;
    margin: 8px;
    color: ${unsafeCSS(colors.accentHover)};
    font-size: 12px;
  }
  .automation-management .muted {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .config-group-title {
    margin: 24px 0 10px;
    font-size: 15px;
  }
  .team-config-card,
  .rule-config-card {
    padding: 14px;
    background: ${unsafeCSS(colors.bgSurface)};
  }
  .team-config-card {
    border-left: 3px solid ${unsafeCSS(colors.accentHover)};
  }
  .rule-config-card {
    border-left: 3px solid #06b6d4;
  }
  .team-config-card h3,
  .rule-config-card h3 {
    margin: 0;
    font-size: 14px;
  }
  .team-config-card p,
  .rule-config-card p {
    font-size: 12px;
    line-height: 1.5;
  }
  .team-config-card > p {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .team-config-card > .row,
  .rule-config-card > .row {
    margin-bottom: 10px;
  }
  .config-kind,
  .config-state {
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 3px 7px;
    font-size: 12px;
  }
  .team-kind {
    color: ${unsafeCSS(colors.accentHover)};
  }
  .rule-kind {
    color: #22d3ee;
  }
  .config-state {
    margin-left: auto;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .config-state[data-enabled='true'] {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .monitor-card {
    padding: 0;
    margin: 12px 0;
    border: 1px solid ${unsafeCSS(colors.textSecondary)};
    border-left: 3px solid ${unsafeCSS(colors.accentHover)};
    color: ${unsafeCSS(colors.textPrimary)};
    background: ${unsafeCSS(colors.bgSurface)};
    overflow-wrap: anywhere;
  }
  .monitor-card > summary {
    display: flex;
    gap: 12px;
    padding: 14px;
    margin: 0;
    list-style: none;
    font-weight: normal;
  }
  .monitor-card > summary::-webkit-details-marker {
    display: none;
  }
  .monitor-card > summary::before {
    content: '›';
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 20px;
    line-height: 1;
    align-self: flex-start;
  }
  .monitor-card[open] > summary::before {
    transform: rotate(90deg);
  }
  .monitor-card > summary:hover,
  .monitor-card[open] > summary {
    background: ${unsafeCSS(colors.bgCard)};
  }
  .monitor-card :is(summary, a, button):focus-visible {
    outline: 2px solid ${unsafeCSS(colors.accentHover)};
    outline-offset: 2px;
  }
  .monitor-heading {
    display: grid;
    gap: 7px;
    min-width: 0;
    flex: 1;
  }
  .monitor-heading-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .monitor-card a {
    color: ${unsafeCSS(colors.accentHover)};
  }
  .monitor-pr {
    font-weight: 600;
    font-size: 12px;
  }
  .monitor-title {
    font-size: 14px;
    line-height: 1.45;
    font-weight: 600;
  }
  .monitor-badge {
    padding: 3px 7px;
    border: 1px solid ${unsafeCSS(colors.textSecondary)};
    border-radius: 4px;
    font-size: 11px;
  }
  .monitor-card .muted,
  .monitor-meta {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 12px;
    line-height: 1.5;
  }
  .monitor-expand-label {
    margin-left: auto;
    color: ${unsafeCSS(colors.accentHover)};
  }
  .monitor-content {
    border-top: 1px solid ${unsafeCSS(colors.textSecondary)};
    padding: 14px;
    font-size: 13px;
    line-height: 1.5;
  }
  .monitor-incidents {
    list-style: none;
    padding: 0;
  }
  .monitor-incidents > li {
    padding: 12px 0;
    border-top: 1px solid ${unsafeCSS(colors.bgCardHover)};
  }
  .monitor-incident-link {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .monitor-action-help {
    margin: 12px 0 0;
  }
  .monitor-card .actions button {
    min-height: 36px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .grid {
    display: grid;
    align-items: start;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr));
    gap: 10px;
  }
  .grid > *,
  .row > * {
    min-width: 0;
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
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
    border: 0;
    padding: 0;
    margin: 10px 0;
  }
  legend {
    margin-bottom: 7px;
    font-size: 12px;
  }
  .setup-form {
    max-width: 960px;
    margin-inline: auto;
  }
  .setup-form > fieldset > details {
    border-top: 1px solid #2a2a44;
    padding-top: 10px;
  }
  .source-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }
  .source-summary {
    overflow-wrap: anywhere;
  }
  .farm-choice {
    flex: 1 1 260px;
  }
  summary {
    font-size: 13px;
    font-weight: 600;
  }
  @media (max-width: 600px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .row > label {
      flex: 1 1 100%;
    }
    section,
    .card {
      padding: 10px;
    }
    .monitor-card {
      padding: 0;
    }
    .monitor-card .actions button {
      min-height: 44px;
    }
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
