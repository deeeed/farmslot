import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const stepInspectorStyles = css`
  :host {
    display: block;
  }

  .inspector {
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .step-name {
    font-weight: 700;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .status {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
  }

  .duration {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }

  .close {
    margin-left: auto;
    background: none;
    border: none;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    padding: 0 2px;
    line-height: 1;
  }
  .close:hover {
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .retry-btn {
    background: ${unsafeCSS(colors.statusWarn)}18;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}44;
    border-radius: 3px;
    color: ${unsafeCSS(colors.statusWarn)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    cursor: pointer;
    text-transform: uppercase;
  }
  .retry-btn:hover {
    background: ${unsafeCSS(colors.statusWarn)}30;
  }

  .section-title {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 8px;
    margin-bottom: 4px;
  }

  .kv-row {
    display: flex;
    gap: 12px;
    padding: 2px 0;
    align-items: baseline;
  }

  .kv-key {
    color: ${unsafeCSS(colors.textMuted)};
    min-width: 120px;
    flex-shrink: 0;
  }

  .kv-value {
    color: ${unsafeCSS(colors.textPrimary)};
    word-break: break-word;
  }

  .v-bool-true {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .v-bool-false {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .v-cost {
    color: ${unsafeCSS(colors.accent)};
    font-weight: 700;
  }
  .v-duration {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .v-number {
    color: #93c5fd;
  }

  .v-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .v-list-item {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 2px 6px;
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: 3px;
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .v-list-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 2px;
    text-transform: uppercase;
  }

  .v-object {
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: 4px;
    padding: 4px 6px;
    white-space: pre-wrap;
    max-height: 120px;
    overflow-y: auto;
  }

  .cost-summary {
    display: flex;
    gap: ${unsafeCSS(spacing.md)};
    padding: 6px 8px;
    background: ${unsafeCSS(colors.accent)}08;
    border: 1px solid ${unsafeCSS(colors.accent)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    margin-top: 8px;
  }
  .cost-label {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
  }
  .cost-value {
    font-size: 14px;
    font-weight: 700;
    color: ${unsafeCSS(colors.accent)};
  }
  .cost-detail {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .detail {
    margin-top: 8px;
    padding: 6px;
    border-radius: 4px;
    white-space: pre-wrap;
  }
  .detail-fail {
    color: ${unsafeCSS(colors.statusFail)};
    background: ${unsafeCSS(colors.statusFail)}12;
  }
  .detail-running {
    color: ${unsafeCSS(colors.textSecondary)};
    background: ${unsafeCSS(colors.accent)}08;
  }

  .v-output {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    background: #0d0d14;
    border: 1px solid ${unsafeCSS(colors.accent)}15;
    border-radius: 4px;
    padding: 6px 8px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
    line-height: 1.4;
  }

  .step-command {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: #0d0d14;
    border: 1px solid ${unsafeCSS(colors.accent)}22;
    border-radius: 4px;
    margin: 2px 0;
  }
  .command-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .command-label-rerun {
    color: ${unsafeCSS(colors.accent)};
  }
  .command-label-failed {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .command-label-launch {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .command-text {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .copy-btn {
    background: ${unsafeCSS(colors.accent)}18;
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: 3px;
    color: ${unsafeCSS(colors.accent)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 1px 6px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .copy-btn:hover {
    background: ${unsafeCSS(colors.accent)}30;
  }

  .ci-wait-banner {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    margin-top: 8px;
    background: ${unsafeCSS(colors.accent)}10;
    border: 1px solid ${unsafeCSS(colors.accent)}40;
    border-left: 3px solid ${unsafeCSS(colors.accent)};
    border-radius: ${unsafeCSS(radii.sm)};
  }
  .ci-wait-title {
    font-size: 11px;
    font-weight: 700;
    color: ${unsafeCSS(colors.textPrimary)};
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ci-wait-tag {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 2px;
    text-transform: uppercase;
    background: ${unsafeCSS(colors.accent)}30;
    color: ${unsafeCSS(colors.accent)};
  }
  .ci-wait-detail {
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .ci-wait-count {
    color: ${unsafeCSS(colors.textMuted)};
    font-variant-numeric: tabular-nums;
  }
  .ci-wait-warn {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .ci-wait-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .ci-wait-poke {
    background: ${unsafeCSS(colors.accent)}20;
    border: 1px solid ${unsafeCSS(colors.accent)}50;
    border-radius: 3px;
    color: ${unsafeCSS(colors.accent)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    font-weight: 700;
    padding: 3px 10px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .ci-wait-poke:hover:not(:disabled) {
    background: ${unsafeCSS(colors.accent)}35;
  }
  .ci-wait-poke:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .ci-wait-poke-status {
    font-size: 10px;
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .ci-wait-poke-ok {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .ci-wait-poke-err {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .ci-wait-done-banner {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    margin-top: 8px;
    background: ${unsafeCSS(colors.statusOk)}14;
    border: 1px solid ${unsafeCSS(colors.statusOk)}44;
    border-left: 3px solid ${unsafeCSS(colors.statusOk)};
    border-radius: ${unsafeCSS(radii.sm)};
  }
  .ci-wait-done-title {
    font-size: 11px;
    font-weight: 700;
    color: ${unsafeCSS(colors.statusOk)};
  }
  .task-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid ${unsafeCSS(colors.accent)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    margin-top: 6px;
  }
  .task-progress-summary {
    display: flex;
    justify-content: space-between;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    font-weight: 700;
  }
  .task-progress-bar {
    height: 5px;
    border-radius: 999px;
    background: #0d0d14;
    overflow: hidden;
  }
  .task-progress-fill {
    height: 100%;
    background: ${unsafeCSS(colors.statusOk)};
  }
  .task-phase {
    border-top: 1px solid ${unsafeCSS(colors.textMuted)}18;
    padding-top: 4px;
  }
  .task-phase-title {
    display: flex;
    justify-content: space-between;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    margin-bottom: 2px;
  }
  .task-progress-step {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    padding: 1px 0;
  }
  .task-progress-step.done {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .task-progress-step.running {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 700;
  }
  .review-loop {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }
  .review-loop-row {
    display: grid;
    grid-template-columns: 84px 1fr;
    gap: 8px;
    padding: 7px 8px;
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
  }
  .review-loop-row.pass {
    border-color: ${unsafeCSS(colors.statusOk)}44;
  }
  .review-loop-row.issues {
    border-color: ${unsafeCSS(colors.statusWarn)}55;
  }
  .review-loop-row.failed {
    border-color: ${unsafeCSS(colors.statusFail)}55;
  }
  .review-loop-badge {
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .review-loop-body {
    min-width: 0;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
  }
  .review-loop-meta {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    margin-top: 2px;
  }
  .review-loop-issue {
    margin-top: 4px;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 10px;
    line-height: 1.35;
  }
  .review-loop-file {
    color: ${unsafeCSS(colors.accent)};
  }
  .review-loop-fix {
    margin: -2px 0;
    padding-left: 48px;
    color: ${unsafeCSS(colors.statusOk)};
    font-size: 10px;
  }
  .review-loop-segments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }
  .review-loop-segment {
    padding: 3px 7px;
    border-radius: 999px;
    background: ${unsafeCSS(colors.accent)}12;
    border: 1px solid ${unsafeCSS(colors.accent)}30;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 10px;
  }
  .review-loop-segment.fix {
    background: ${unsafeCSS(colors.statusOk)}12;
    border-color: ${unsafeCSS(colors.statusOk)}35;
  }
`;
