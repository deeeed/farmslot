import { css, unsafeCSS } from 'lit';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

export const dispatchWizardStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${unsafeCSS(colors.bgBase)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .header {
    display: flex;
    align-items: center;
    padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
    background: ${unsafeCSS(colors.bgSurface)};
    border-bottom: 1px solid #1e1e36;
    flex-shrink: 0;
  }

  .header-title {
    font-size: ${unsafeCSS(fonts.sizeLg)};
    font-weight: 600;
  }

  .body {
    flex: 1;
    padding: ${unsafeCSS(spacing.xl)};
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.xl)};
    max-width: 680px;
  }

  /* ── Sections ── */
  .section-label {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }

  .section-help {
    margin-top: 6px;
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
    line-height: 1.4;
  }

  /* ── Pill row (flow, project, model, runner, effort, slot) ── */
  .pill-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .pill {
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid #2a2a44;
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      background 0.12s,
      color 0.12s;
    white-space: nowrap;
  }

  .pill:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .pill.selected {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}18;
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
  }

  .pill:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .pill .pill-key {
    font-size: 9px;
    opacity: 0.5;
    margin-left: 4px;
  }

  /* ── Ticket input ── */
  .ticket-input {
    width: 100%;
    background: ${unsafeCSS(colors.bgInput)};
    border: 1px solid #2a2a44;
    border-radius: 4px;
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 13px;
    padding: 8px 12px;
    outline: none;
    box-sizing: border-box;
  }

  .ticket-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  /* ── Prior-runs comparison banner ── */
  .prior-runs-banner {
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    background: ${unsafeCSS(colors.accent)}10;
    border-radius: 4px;
    padding: 8px 10px;
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .prior-runs-banner-title {
    font-weight: 600;
    color: ${unsafeCSS(colors.accent)};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 10px;
  }

  .prior-runs-family {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .prior-runs-family-label {
    font-size: 9px;
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .prior-run-row {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 8px;
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid #2a2a44;
    border-radius: 3px;
    font-family: ${unsafeCSS(fonts.mono)};
    cursor: pointer;
    text-align: left;
    color: ${unsafeCSS(colors.textSecondary)};
    transition:
      border-color 0.12s,
      background 0.12s;
  }

  .prior-run-row:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .prior-run-cell {
    white-space: nowrap;
  }
  .prior-run-cell.muted {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .prior-run-cell.summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${unsafeCSS(colors.textMuted)};
  }

  /* ── Comparison-mode persistent indicator ── */
  .comparison-mode-banner {
    border: 1px solid ${unsafeCSS(colors.statusWarn)}88;
    background: ${unsafeCSS(colors.statusWarn)}14;
    border-radius: 4px;
    padding: 8px 10px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font-size: 11px;
  }

  .comparison-mode-title {
    font-weight: 700;
    color: ${unsafeCSS(colors.statusWarn)};
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-size: 10px;
  }

  .comparison-mode-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
    flex: 1;
  }

  .cm-label {
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-size: 9px;
    margin-right: 4px;
  }

  .comparison-mode-exit {
    background: none;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}66;
    color: ${unsafeCSS(colors.statusWarn)};
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 10px;
    font-family: ${unsafeCSS(fonts.mono)};
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s;
  }

  .comparison-mode-exit:hover {
    background: ${unsafeCSS(colors.statusWarn)}22;
    border-color: ${unsafeCSS(colors.statusWarn)};
  }

  .start-ref-panel {
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    background:
      linear-gradient(135deg, ${unsafeCSS(colors.accent)}18, ${unsafeCSS(colors.bgCard)} 56%),
      ${unsafeCSS(colors.bgCard)};
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 0 0 1px #00000022 inset;
  }

  .start-ref-panel.active {
    border-color: ${unsafeCSS(colors.statusOk)}88;
    background:
      linear-gradient(135deg, ${unsafeCSS(colors.statusOk)}16, ${unsafeCSS(colors.bgCard)} 58%),
      ${unsafeCSS(colors.bgCard)};
  }

  .start-ref-head {
    display: flex;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    align-items: flex-start;
  }

  .start-ref-copy,
  .start-ref-help {
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    line-height: 1.4;
  }

  .start-ref-badge {
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
    border-radius: 999px;
    padding: 2px 7px;
    font-size: 9px;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .start-ref-badge.active {
    border-color: ${unsafeCSS(colors.statusOk)}66;
    color: ${unsafeCSS(colors.statusOk)};
    background: ${unsafeCSS(colors.statusOk)}14;
  }

  .start-ref-field-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .start-ref-input {
    width: 100%;
    background: ${unsafeCSS(colors.bgInput)};
    border: 1px solid #2a2a44;
    border-radius: 4px;
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
    padding: 7px 10px;
    outline: none;
    box-sizing: border-box;
  }

  .start-ref-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  .start-ref-clear {
    background: transparent;
    border: 1px solid #2a2a44;
    color: ${unsafeCSS(colors.textSecondary)};
    border-radius: 4px;
    padding: 7px 10px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    cursor: pointer;
  }

  .start-ref-clear:hover {
    border-color: ${unsafeCSS(colors.accent)}88;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .start-ref-steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .start-ref-steps span {
    border: 1px solid #2a2a44;
    border-radius: 4px;
    padding: 6px 7px;
    background: #00000014;
    min-width: 0;
  }

  .start-ref-steps span.on {
    border-color: ${unsafeCSS(colors.statusOk)}55;
    color: ${unsafeCSS(colors.statusOk)};
    background: ${unsafeCSS(colors.statusOk)}0f;
  }

  .start-ref-steps b {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
  }

  .start-ref-help.active {
    color: ${unsafeCSS(colors.statusOk)};
  }

  /* ── Variant input (collision resolution) ── */
  .variant-input-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .variant-input {
    width: 100%;
    background: ${unsafeCSS(colors.bgInput)};
    border: 1px solid ${unsafeCSS(colors.statusWarn)};
    border-radius: 4px;
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
    padding: 6px 10px;
    outline: none;
    box-sizing: border-box;
  }

  .variant-input:focus {
    border-color: ${unsafeCSS(colors.accent)};
  }

  .variant-input-hint {
    font-size: 10px;
    color: ${unsafeCSS(colors.statusWarn)};
  }

  /* ── Config row (model + runner + effort inline) ── */
  .config-row {
    display: flex;
    gap: ${unsafeCSS(spacing.xl)};
    flex-wrap: wrap;
  }

  .config-group {
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .publication-review-panel {
    border: 1px solid #2a2a44;
    border-radius: 8px;
    background: ${unsafeCSS(colors.bgSurface)};
    padding: ${unsafeCSS(spacing.md)};
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .publication-review-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
  }

  .publication-review-summary {
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    border-radius: 999px;
    color: ${unsafeCSS(colors.accent)};
    font-size: 10px;
    padding: 2px 8px;
    white-space: nowrap;
  }

  .publication-review-sequence {
    display: grid;
    gap: 6px;
  }

  .publication-review-row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto auto auto;
    gap: 8px;
    align-items: center;
    min-height: 30px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: 6px;
    padding: 5px 7px;
    background: ${unsafeCSS(colors.bgBase)};
    font-size: 11px;
  }

  .publication-review-row.base {
    grid-template-columns: 34px minmax(0, 1fr) auto;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .publication-review-index {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
  }

  .publication-review-base {
    color: ${unsafeCSS(colors.textSecondary)};
    font-weight: 600;
  }

  .publication-review-runners,
  .publication-review-depth,
  .publication-review-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .review-runner-chip,
  .review-remove {
    border: 1px solid #2a2a44;
    border-radius: 5px;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 3px 7px;
  }

  .review-runner-chip.selected {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}18;
    color: ${unsafeCSS(colors.accent)};
  }

  .publication-review-kind {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    white-space: nowrap;
  }

  .review-remove:hover,
  .review-runner-chip:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  /* ── Slot chips ── */
  .pill.slot-pill {
    font-size: 11px;
    padding: 4px 8px;
  }

  .slot-health {
    font-size: 9px;
    opacity: 0.6;
    margin-left: 3px;
  }

  /* ── Candidate list ── */
  .candidate-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .candidate-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid #2a2a44;
    border-radius: 3px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    cursor: pointer;
    transition:
      border-color 0.12s,
      background 0.12s;
    text-align: left;
  }

  .candidate-row:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .candidate-row:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .candidate-row:disabled:hover {
    border-color: #2a2a44;
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .candidate-row.selected {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}10;
  }

  .cand-rank {
    width: 20px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }

  .candidate-row.selected .cand-rank {
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
  }

  .cand-id {
    width: 112px;
    color: ${unsafeCSS(colors.textPrimary)};
    flex-shrink: 0;
  }

  .cand-summary {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
  }

  .cand-branch {
    font-size: 12px;
    line-height: 1.35;
    color: ${unsafeCSS(colors.textPrimary)};
    width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .cand-branch.stale {
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .cand-task {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    line-height: 1.3;
    width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .cand-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    align-self: flex-start;
    padding-top: 1px;
  }

  .cand-cdp {
    font-size: 10px;
    width: 28px;
    text-align: center;
  }
  .cand-lifecycle {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    width: 56px;
  }
  .cand-score {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    width: 20px;
    text-align: right;
  }

  .cand-reuse {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    background: ${unsafeCSS(colors.accent)}22;
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    color: ${unsafeCSS(colors.accent)};
    white-space: nowrap;
  }

  .candidate-row.nudge-eligible {
    border-color: ${unsafeCSS(colors.statusWarn)}55;
    background: ${unsafeCSS(colors.statusWarn)}0a;
  }
  .candidate-row.nudge-eligible.selected {
    border-color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.statusWarn)}1a;
  }

  .cand-nudge-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    background: ${unsafeCSS(colors.statusWarn)}22;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}88;
    color: ${unsafeCSS(colors.statusWarn)};
    white-space: nowrap;
    letter-spacing: 0.5px;
  }

  .cand-nudge-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
  }

  .chip {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid #2a2a44;
    color: ${unsafeCSS(colors.textMuted)};
    white-space: nowrap;
  }
  .chip.danger {
    border-color: ${unsafeCSS(colors.statusFail)}66;
    color: ${unsafeCSS(colors.statusFail)};
  }
  .chip.warn {
    border-color: ${unsafeCSS(colors.statusWarn)}66;
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .cand-actions {
    display: flex;
    gap: 4px;
  }
  .nudge-action {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 3px;
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid #2a2a44;
    color: ${unsafeCSS(colors.textSecondary)};
    cursor: pointer;
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .nudge-action:hover {
    border-color: ${unsafeCSS(colors.accent)}88;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .nudge-action.on {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
  }

  .same-task-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 3px;
    background: ${unsafeCSS(colors.statusWarn)}18;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}55;
    font-size: 11px;
    color: ${unsafeCSS(colors.statusWarn)};
    margin-bottom: 4px;
  }

  .same-task-warning .stw-slot {
    font-weight: 600;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .same-task-warning .stw-status {
    color: ${unsafeCSS(colors.textMuted)};
  }

  /* ── Actions ── */
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
    padding-top: ${unsafeCSS(spacing.md)};
    border-top: 1px solid #1e1e36;
  }

  .btn {
    padding: 7px 18px;
    border-radius: 4px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 12px;
    font-weight: 600;
    border: 1px solid #2a2a44;
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textPrimary)};
    cursor: pointer;
  }

  .btn:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }

  .btn.primary {
    background: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)};
    color: #fff;
  }

  .btn.primary:hover {
    opacity: 0.9;
  }
  .btn.primary:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .error-msg {
    color: ${unsafeCSS(colors.statusFail)};
    font-size: 12px;
  }

  .error-action {
    color: ${unsafeCSS(colors.accent)};
    cursor: pointer;
    text-decoration: underline;
    margin-left: 6px;
  }

  .validation-hint {
    color: ${unsafeCSS(colors.statusWarn)};
    font-size: 11px;
  }

  .spacer {
    flex: 1;
  }

  .rehydrating-banner {
    color: ${unsafeCSS(colors.statusWarn)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    font-family: ${unsafeCSS(fonts.mono)};
    padding: 0 ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.sm)};
  }
  .body.rehydrating {
    opacity: 0.72;
    pointer-events: none;
  }
`;
