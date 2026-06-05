import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const familyObservabilityEvidenceStyles = css`
  .evidence-provenance-note {
    margin: ${unsafeCSS(spacing.sm)} 0;
    padding: ${unsafeCSS(spacing.sm)};
    border: 1px solid ${unsafeCSS(colors.accent)}33;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.accent)}08;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    line-height: 1.45;
  }
  .evidence-filter-row {
    display: flex;
    gap: 6px;
    margin: ${unsafeCSS(spacing.sm)} 0;
    flex-wrap: wrap;
  }
  .evidence-filter-chip {
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: transparent;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .evidence-filter-chip:hover {
    border-color: ${unsafeCSS(colors.textMuted)}88;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .evidence-filter-chip.active {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border-color: ${unsafeCSS(colors.accent)}66;
  }
  .evidence-groups {
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.md)};
  }
  .evidence-group {
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgBase)}55;
    padding: ${unsafeCSS(spacing.sm)};
  }
  .evidence-group.carried {
    border-color: ${unsafeCSS(colors.statusWarn)}55;
    background: ${unsafeCSS(colors.statusWarn)}08;
  }
  .evidence-group-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .evidence-group-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    font-weight: 700;
  }
  .evidence-group-meta {
    margin-top: 3px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    line-height: 1.4;
  }
  .evidence-group-count {
    flex-shrink: 0;
    min-width: 22px;
    text-align: center;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 2px 6px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .evidence-group-more {
    margin-top: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
  }
  .evidence-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }
  .artifact-card {
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: ${unsafeCSS(radii.sm)};
    overflow: hidden;
  }
  .artifact-wrapper {
    position: relative;
  }
  .artifact-button {
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    background: transparent;
    color: inherit;
    font-family: inherit;
    width: 100%;
    display: block;
  }
  .artifact-button:hover {
    outline: 2px solid ${unsafeCSS(colors.accent)}55;
  }
  .artifact-preview,
  .artifact-fallback {
    width: 100%;
    height: 120px;
    object-fit: cover;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${unsafeCSS(colors.bgBase)};
  }
  .artifact-video-preview {
    position: relative;
    width: 100%;
    height: 120px;
    background: ${unsafeCSS(colors.bgBase)};
  }
  .artifact-video-preview .artifact-preview {
    height: 100%;
    pointer-events: none;
  }
  .artifact-video-review-badge {
    position: absolute;
    left: 8px;
    bottom: 8px;
    border-radius: 999px;
    padding: 3px 8px;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    pointer-events: none;
  }
  .artifact-meta {
    padding: 8px;
  }
  .artifact-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .artifact-run-tag {
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: 3px;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 9px;
    padding: 1px 5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .artifact-run-tag.carried {
    border-color: ${unsafeCSS(colors.statusWarn)}66;
    color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.statusWarn)}11;
  }
  .artifact-purpose {
    color: ${unsafeCSS(colors.accent)};
    font-size: 10px;
    text-transform: uppercase;
  }
  .artifact-path {
    font-size: 11px;
    word-break: break-all;
  }
  .artifact-caption {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    margin-top: 4px;
  }
  .artifact-broken {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .compare-chip {
    position: absolute;
    top: 6px;
    right: 6px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.bgCard)}dd;
    color: ${unsafeCSS(colors.accent)};
    border-radius: ${unsafeCSS(radii.sm)};
    font-family: inherit;
    font-size: 10px;
    padding: 3px 7px;
    cursor: pointer;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .compare-chip:hover {
    background: ${unsafeCSS(colors.accent)};
    color: #000;
  }
  .panel-hint {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: none;
    letter-spacing: normal;
  }
  .recipe-graph-wrap {
    max-height: 420px;
    overflow: auto;
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .recipe-actions {
    display: flex;
    flex-wrap: wrap;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
    margin-top: ${unsafeCSS(spacing.md)};
    padding-top: ${unsafeCSS(spacing.sm)};
    border-top: 1px solid ${unsafeCSS(colors.textMuted)}22;
  }
  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .action-btn {
    cursor: pointer;
  }
  .recipe-hint {
    font-size: 10px;
  }
  .report-panel {
    margin-bottom: ${unsafeCSS(spacing.lg)};
  }
  .report-status {
    margin: 8px 0;
    font-size: 11px;
  }
  .report-status.generated {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .report-status.fallback {
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .report-block {
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .run-item {
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
    text-align: left;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    color: inherit;
    margin-bottom: ${unsafeCSS(spacing.sm)};
    font-family: inherit;
    cursor: pointer;
  }
  .run-item.selected {
    border-color: ${unsafeCSS(colors.accent)}66;
    background: ${unsafeCSS(colors.accent)}11;
  }
  .run-item.terminal-alert {
    border-color: var(--run-status-color);
    border-left: 3px solid var(--run-status-color);
    background: linear-gradient(90deg, var(--run-status-bg), ${unsafeCSS(colors.bgSurface)} 45%);
  }
  .run-item.terminal-alert.selected {
    border-color: ${unsafeCSS(colors.accent)}66;
    border-left-color: var(--run-status-color);
  }
  .run-item-top {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .run-item-meta {
    word-break: break-word;
  }
  .slot-link {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    cursor: pointer;
  }
  .ticket-link {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
  }
  .ticket-link:hover {
    text-decoration: underline;
  }
  .pr-link {
    cursor: pointer;
    text-decoration: none;
  }
  .pr-link:hover {
    filter: brightness(1.2);
  }
  .pipeline-host {
    padding: 0;
  }
  .pipeline-host run-pipeline {
    display: block;
  }
  .detail-link {
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    background: ${unsafeCSS(colors.accent)}22;
    border: 1px solid ${unsafeCSS(colors.accent)}88;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 3px 7px;
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    width: max-content;
    max-width: 100%;
  }
  button.detail-link {
    appearance: none;
  }
  .detail-link:hover {
    background: ${unsafeCSS(colors.accent)}33;
    border-color: ${unsafeCSS(colors.accent)};
  }
  .inline-diff-link {
    vertical-align: middle;
  }
  .replay-error {
    color: ${unsafeCSS(colors.statusFail)};
    padding: 6px 10px;
    background: ${unsafeCSS(colors.statusFail)}11;
    border-radius: ${unsafeCSS(radii.sm)};
    margin-top: 6px;
    font-size: 12px;
  }
  .slot-link:hover {
    text-decoration: underline;
  }
  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .badge.status {
    border: 1px solid currentColor;
    background: transparent;
  }
  .badge.slot {
    border: 1px solid ${unsafeCSS(colors.textMuted)}55;
    color: ${unsafeCSS(colors.textSecondary)};
    background: ${unsafeCSS(colors.bgBase)};
  }
  .badge.ledger {
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}11;
  }
  .badge.warn {
    border: 1px solid ${unsafeCSS(colors.statusWarn)}66;
    color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.statusWarn)}11;
  }
  .run-item-title {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .run-item-meta {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
  }
  .related-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }
  .related-item {
    display: block;
    text-decoration: none;
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    background: ${unsafeCSS(colors.bgSurface)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    color: inherit;
    font-family: inherit;
    cursor: pointer;
  }
  .related-item:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
  }
  .run-summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }
  .run-summary-grid div {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .detail-section {
    margin-top: ${unsafeCSS(spacing.md)};
  }
  .diff-detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }
  .diff-detail-card {
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .detail-link {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 3px 7px;
    font-size: 10px;
    width: max-content;
  }
  .detail-link:hover {
    background: ${unsafeCSS(colors.accent)}22;
  }
  .step-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .empty {
    color: ${unsafeCSS(colors.textMuted)};
    padding: ${unsafeCSS(spacing.xl)};
  }
  .artifact-md-preview {
    width: 100%;
    height: 120px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: ${unsafeCSS(colors.bgBase)};
    box-sizing: border-box;
    align-items: flex-start;
    justify-content: flex-start;
  }
  .artifact-md-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 2px 6px;
    border-radius: 3px;
    background: ${unsafeCSS(colors.accent)};
    color: #000;
  }
  .artifact-md-firstline {
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
  }
  .learning-list {
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .learning-card {
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}22;
    border-left: 3px solid ${unsafeCSS(colors.textMuted)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: ${unsafeCSS(spacing.sm)};
  }
  .learning-card.learning-sev-info {
    border-left-color: ${unsafeCSS(colors.accent)};
  }
  .learning-card.learning-sev-warn {
    border-left-color: ${unsafeCSS(colors.statusWarn)};
  }
  .learning-card.learning-sev-error {
    border-left-color: ${unsafeCSS(colors.statusFail)};
  }
  .learning-head {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    margin-bottom: 4px;
  }
  .learning-sev-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${unsafeCSS(colors.textMuted)};
    flex-shrink: 0;
  }
  .learning-sev-dot.learning-sev-info {
    background: ${unsafeCSS(colors.accent)};
  }
  .learning-sev-dot.learning-sev-warn {
    background: ${unsafeCSS(colors.statusWarn)};
  }
  .learning-sev-dot.learning-sev-error {
    background: ${unsafeCSS(colors.statusFail)};
  }
  .learning-title {
    font-weight: 600;
    font-size: 12px;
    flex: 1;
  }
  .learning-source {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    padding: 1px 6px;
    border-radius: 3px;
    letter-spacing: 0.03em;
  }
  .learning-body {
    font-size: 12px;
    color: ${unsafeCSS(colors.textSecondary)};
    line-height: 1.5;
  }
  .learning-detail {
    margin-top: 6px;
    font-size: 11px;
  }
  .learning-detail > summary {
    cursor: pointer;
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .learning-detail-body {
    margin-top: 6px;
    padding: ${unsafeCSS(spacing.sm)};
    background: ${unsafeCSS(colors.bgBase)};
    border-radius: ${unsafeCSS(radii.sm)};
    line-height: 1.5;
  }
  .learning-detail-body :is(h1, h2, h3, h4) {
    margin: 8px 0 4px;
    font-size: 12px;
  }
  .learning-detail-body :is(p, ul, ol) {
    margin: 4px 0;
  }
  .learning-detail-body code {
    font-family: ${unsafeCSS(fonts.mono)};
    background: ${unsafeCSS(colors.bgSurface)};
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }
  .learning-detail-body pre {
    background: ${unsafeCSS(colors.bgSurface)};
    padding: 8px;
    border-radius: ${unsafeCSS(radii.sm)};
    overflow: auto;
  }
  .learning-detail-body pre code {
    background: transparent;
    padding: 0;
  }
  .learning-foot {
    display: flex;
    gap: ${unsafeCSS(spacing.md)};
    margin-top: 6px;
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .converged-pill {
    display: inline-block;
    margin-left: ${unsafeCSS(spacing.sm)};
    padding: 2px 8px;
    border-radius: 12px;
    background: ${unsafeCSS(colors.statusOk)}22;
    color: ${unsafeCSS(colors.statusOk)};
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    vertical-align: middle;
  }
  .grade-panel {
    margin-top: ${unsafeCSS(spacing.md)};
    padding-top: ${unsafeCSS(spacing.sm)};
    border-top: 1px solid ${unsafeCSS(colors.textMuted)}22;
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .grade-title {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .grade-row {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    flex-wrap: wrap;
  }
  .grade-label {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
  }
  .grade-chip {
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .grade-reasoning {
    flex: 1;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 12px;
  }
  .grade-meta {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .grade-link {
    background: transparent;
    border: none;
    color: ${unsafeCSS(colors.textMuted)};
    text-decoration: underline;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .grade-link:hover {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .verdict-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .verdict-chip {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .verdict-chip.verdict-pass {
    border-color: ${unsafeCSS(colors.statusOk)};
    color: ${unsafeCSS(colors.statusOk)};
  }
  .verdict-chip.verdict-fail {
    border-color: ${unsafeCSS(colors.statusFail)};
    color: ${unsafeCSS(colors.statusFail)};
  }
  .verdict-chip.verdict-not-applicable {
    border-color: ${unsafeCSS(colors.textMuted)};
    color: ${unsafeCSS(colors.textMuted)};
  }
  .verdict-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .verdict-row {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
  }
  .verdict-target {
    font-size: 12px;
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .verdict-pills {
    display: flex;
    gap: 4px;
  }
  .verdict-pill {
    font-family: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textMuted)};
  }
  .verdict-pill:hover {
    opacity: 0.85;
  }
  .verdict-pill[disabled] {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .verdict-pill.pass.selected {
    border-color: ${unsafeCSS(colors.statusOk)};
    color: ${unsafeCSS(colors.statusOk)};
    background: ${unsafeCSS(colors.statusOk)}18;
  }
  .verdict-pill.fail.selected {
    border-color: ${unsafeCSS(colors.statusFail)};
    color: ${unsafeCSS(colors.statusFail)};
    background: ${unsafeCSS(colors.statusFail)}18;
  }
  .verdict-pill.not-applicable.selected {
    border-color: ${unsafeCSS(colors.textMuted)};
    color: ${unsafeCSS(colors.textMuted)};
    background: ${unsafeCSS(colors.textMuted)}22;
  }
  .verdict-note {
    font-family: inherit;
    font-size: 11px;
    padding: 4px 8px;
    background: ${unsafeCSS(colors.bgSurface)};
    color: ${unsafeCSS(colors.textPrimary)};
    border: 1px solid ${unsafeCSS(colors.bgInput)};
    border-radius: ${unsafeCSS(radii.sm)};
    outline: none;
  }
  .verdict-note:focus {
    border-color: ${unsafeCSS(colors.accent)}88;
  }
  .grade-derived {
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .grade-error {
    color: ${unsafeCSS(colors.statusFail)};
    font-size: 11px;
  }
  .grade-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    justify-content: flex-end;
  }
  .action-btn.primary {
    background: ${unsafeCSS(colors.accent)};
    color: #fff;
    border-color: ${unsafeCSS(colors.accent)};
  }
  .improvement-trigger {
    margin-top: ${unsafeCSS(spacing.sm)};
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: ${unsafeCSS(spacing.xs)};
  }
  .improvement-trigger-row {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .improvement-hint {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .improvement-hint.active {
    color: ${unsafeCSS(colors.accent)};
  }
  .improvement-badge {
    background: ${unsafeCSS(colors.accent)}22;
    color: ${unsafeCSS(colors.accent)};
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    padding: 1px 6px;
    border-radius: ${unsafeCSS(radii.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    letter-spacing: 0.3px;
  }
  .improvement-duration,
  .improvement-elapsed {
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .improvement-async {
    font-style: italic;
    opacity: 0.85;
  }
  .pulse-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${unsafeCSS(colors.accent)};
    margin-right: ${unsafeCSS(spacing.xs)};
    animation: omc-pulse 1s ease-in-out infinite;
  }
  @keyframes omc-pulse {
    0%,
    100% {
      opacity: 0.4;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1.2);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse-dot {
      animation: none;
      opacity: 1;
    }
  }
  @media (max-width: 1000px) {
    .output-compare-grid {
      grid-template-columns: 1fr;
    }
  }
  .proposal-error {
    color: ${unsafeCSS(colors.statusFail)};
    font-size: 11px;
  }
`;
