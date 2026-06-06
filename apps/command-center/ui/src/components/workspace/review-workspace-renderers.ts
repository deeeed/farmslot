import { html } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import type { RecoveryPhase } from '../../utils/reconnect.js';

export function renderReviewWorkspaceStyles(recoveryPhase: RecoveryPhase) {
  return html`<style>
    review-workspace {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeSm};
      color: ${colors.textPrimary};
      background: ${colors.bgBase};
    }
    review-workspace .rw-top-bar {
      display: flex;
      align-items: center;
      gap: ${spacing.md};
      padding: ${spacing.sm} ${spacing.lg};
      background: ${colors.bgCard};
      border-bottom: 1px solid #2a2a44;
      flex-shrink: 0;
    }
    review-workspace .rw-rec-selector {
      display: flex;
      gap: 2px;
      align-items: center;
    }
    review-workspace .rw-rec-opt {
      font-family: ${fonts.mono};
      font-weight: 700;
      padding: 2px 8px;
      border-radius: ${radii.sm};
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid transparent;
      background: transparent;
      transition:
        background 0.1s,
        color 0.1s,
        border-color 0.1s;
    }
    review-workspace .rw-rec-opt:hover:not(.active) {
      border-color: currentColor;
      opacity: 0.7;
    }
    review-workspace .rw-rec-opt.active {
      border-color: transparent;
    }
    review-workspace .rw-comment-summary {
      font-size: 11px;
      color: ${colors.textSecondary};
    }
    review-workspace .rw-sev-pill {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 9px;
      text-transform: uppercase;
      margin-left: 2px;
    }
    review-workspace .rw-spacer {
      flex: 1;
    }
    review-workspace .rw-action-btn {
      font-family: ${fonts.mono};
      font-size: 12px;
      font-weight: 600;
      padding: 6px 16px;
      border-radius: ${radii.md};
      cursor: pointer;
      border: none;
      transition: opacity 0.15s;
    }
    review-workspace .rw-action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    review-workspace .rw-action-btn:hover:not(:disabled) {
      opacity: 0.85;
    }
    review-workspace .rw-btn-post {
      background: ${colors.accent};
      color: #fff;
    }
    review-workspace .rw-btn-dismiss {
      background: #333344;
      color: ${colors.textSecondary};
    }
    @keyframes rw-pulse-border {
      0% {
        opacity: 1;
      }
      100% {
        opacity: 0.7;
      }
    }
    review-workspace .rw-confirming {
      background: ${colors.statusWarn}22;
      border: 1px solid ${colors.statusWarn};
      color: ${colors.statusWarn};
      animation: rw-pulse-border 0.6s ease-in-out infinite alternate;
    }

    review-workspace .rw-branch-banner {
      display: flex;
      align-items: center;
      gap: ${spacing.md};
      padding: ${spacing.sm} ${spacing.lg};
      background: ${colors.statusWarn}12;
      border-bottom: 1px solid ${colors.statusWarn}33;
      font-size: 12px;
      color: ${colors.statusWarn};
      flex-shrink: 0;
    }
    review-workspace .rw-branch-banner strong {
      color: ${colors.textPrimary};
    }

    review-workspace .rw-split {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    review-workspace .rw-md-section {
      overflow-y: auto;
      padding: ${spacing.md} ${spacing.xl};
      font-size: 13px;
      line-height: 1.7;
      min-height: 80px;
    }
    review-workspace .rw-review-snapshot {
      display: flex;
      align-items: center;
      gap: ${spacing.sm};
      padding: ${spacing.sm} ${spacing.xl};
      background: ${colors.bgSurface};
      border-bottom: 1px solid #2a2a44;
      color: ${colors.textSecondary};
      font-size: 11px;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    review-workspace .rw-snapshot-stale {
      color: ${colors.statusFail};
      background: ${colors.statusFail}18;
      border: 1px solid ${colors.statusFail}44;
      border-radius: 999px;
      padding: 1px 7px;
      text-transform: uppercase;
      font-size: 9px;
      font-weight: 700;
    }
    review-workspace .rw-snapshot-diff {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #2a2a44;
      border-radius: ${radii.sm};
      background: ${colors.bgCard};
      color: ${colors.textSecondary};
      font: inherit;
      font-size: 11px;
      padding: 2px 8px;
      cursor: pointer;
    }
    review-workspace .rw-snapshot-diff:hover {
      border-color: ${colors.accent};
      color: ${colors.textPrimary};
    }
    review-workspace .rw-resize {
      height: 4px;
      background: #2a2a44;
      cursor: row-resize;
      flex-shrink: 0;
      position: relative;
    }
    review-workspace .rw-resize:hover {
      background: ${colors.accent}44;
    }
    review-workspace .rw-bottom {
      display: flex;
      min-height: 100px;
      overflow: hidden;
    }
    review-workspace .rw-comments-sb {
      width: 300px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      border-right: 1px solid #2a2a44;
      overflow: hidden;
    }
    review-workspace .rw-sb-header {
      display: flex;
      align-items: center;
      gap: ${spacing.sm};
      padding: ${spacing.sm} ${spacing.md};
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: ${colors.textMuted};
      background: ${colors.bgCard};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }
    review-workspace .rw-comment-list {
      overflow-y: auto;
      flex: 1;
    }
    review-workspace .rw-ci {
      display: flex;
      align-items: flex-start;
      gap: ${spacing.sm};
      padding: ${spacing.sm} ${spacing.md};
      border-bottom: 1px solid #1e1e3622;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.1s;
    }
    review-workspace .rw-ci:hover {
      background: ${colors.bgCard};
    }
    review-workspace .rw-ci.active {
      background: ${colors.accent}12;
      border-left: 2px solid ${colors.accent};
    }
    review-workspace .rw-ci input[type='checkbox'] {
      margin-top: 2px;
      accent-color: ${colors.accent};
      cursor: pointer;
      flex-shrink: 0;
    }
    review-workspace .rw-ci-content {
      flex: 1;
      min-width: 0;
    }
    review-workspace .rw-ci-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 1px;
    }
    review-workspace .rw-ci-path {
      font-size: 10px;
      color: ${colors.textMuted};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    review-workspace .rw-ci-body {
      color: ${colors.textSecondary};
      line-height: 1.4;
    }

    review-workspace .rw-diff-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }
    review-workspace .rw-file-tabs {
      display: flex;
      flex-wrap: nowrap;
      gap: 1px;
      background: ${colors.bgCard};
      border-bottom: 1px solid #2a2a44;
      padding: 2px ${spacing.sm};
      flex-shrink: 0;
      overflow-x: auto;
    }
    review-workspace .rw-ft {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border: none;
      background: transparent;
      color: ${colors.textMuted};
      font-family: ${fonts.mono};
      font-size: 11px;
      cursor: pointer;
      border-radius: 3px;
      white-space: nowrap;
    }
    review-workspace .rw-ft:hover {
      background: ${colors.bgSurface};
      color: ${colors.textSecondary};
    }
    review-workspace .rw-ft.selected {
      background: ${colors.accent}18;
      color: ${colors.textPrimary};
    }
    review-workspace .rw-fc-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 0 5px;
      border-radius: 8px;
    }
    review-workspace .rw-diff-area diff-review,
    review-workspace .rw-diff-area code-viewer {
      flex: 1;
      min-height: 0;
      height: auto;
    }
    review-workspace .rw-diff-loading,
    review-workspace .rw-diff-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: ${colors.textMuted};
      font-size: 12px;
    }
    review-workspace .rw-recovery-overlay {
      position: absolute;
      inset: 0;
      z-index: 15;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(10, 10, 15, 0.72);
      backdrop-filter: blur(2px);
    }
    review-workspace .rw-recovery-card {
      width: min(360px, calc(100% - 24px));
      padding: 16px;
      border-radius: ${radii.md};
      border: 1px solid ${colors.accent}44;
      background: ${colors.bgSurface};
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    review-workspace .rw-recovery-eyebrow {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: ${recoveryPhase === 'error' ? colors.statusFail : colors.accent};
    }
    review-workspace .rw-recovery-title {
      font-size: 13px;
      font-weight: 700;
      color: ${colors.textPrimary};
    }
    review-workspace .rw-recovery-copy {
      font-size: 12px;
      line-height: 1.5;
      color: ${colors.textSecondary};
    }
    review-workspace .rw-recovery-actions {
      display: flex;
      justify-content: flex-end;
    }
    review-workspace .rw-recovery-btn {
      font-family: ${fonts.mono};
      font-size: 11px;
      padding: 6px 10px;
      border-radius: ${radii.sm};
      border: 1px solid ${colors.accent}44;
      background: ${colors.accent}22;
      color: ${colors.accent};
      cursor: pointer;
    }
    review-workspace .rw-md-section h1,
    review-workspace .rw-md-section h2,
    review-workspace .rw-md-section h3 {
      color: ${colors.textPrimary};
      margin: 10px 0 4px;
    }
    review-workspace .rw-md-section h2 {
      font-size: 14px;
    }
    review-workspace .rw-md-section h3 {
      font-size: 12px;
    }
    review-workspace .rw-md-section p {
      margin: 4px 0;
    }
    review-workspace .rw-md-section pre {
      background: ${colors.bgSurface};
      border: 1px solid #2a2a44;
      border-radius: ${radii.sm};
      padding: 6px 8px;
      font-size: 11px;
      overflow-x: auto;
    }
    review-workspace .rw-md-section code {
      background: ${colors.bgSurface};
      padding: 1px 4px;
      border-radius: 2px;
      font-size: 11px;
      color: ${colors.accent};
    }
    review-workspace .rw-md-section pre code {
      background: none;
      padding: 0;
      color: ${colors.textSecondary};
    }
    review-workspace .rw-md-section a {
      color: ${colors.accent};
      text-decoration: none;
    }
    review-workspace .rw-md-section strong {
      color: ${colors.textPrimary};
    }
    review-workspace .rw-md-section ul,
    review-workspace .rw-md-section ol {
      margin: 4px 0;
      padding-left: 18px;
    }
    review-workspace .rw-md-section blockquote {
      border-left: 3px solid ${colors.accent};
      margin: 6px 0;
      padding: 2px 10px;
      color: ${colors.textSecondary};
    }
    review-workspace .rw-md-section table {
      border-collapse: collapse;
      margin: 6px 0;
    }
    review-workspace .rw-md-section th,
    review-workspace .rw-md-section td {
      border: 1px solid #2a2a44;
      padding: 3px 8px;
      font-size: 11px;
    }
    review-workspace .rw-md-section th {
      background: ${colors.bgSurface};
      font-weight: 600;
    }

    review-workspace .rw-evidence-toggle {
      font-family: ${fonts.mono};
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: ${radii.sm};
      cursor: pointer;
      border: 1px solid ${colors.accent}44;
      background: ${colors.accent}12;
      color: ${colors.accent};
      transition: background 0.1s;
    }
    review-workspace .rw-evidence-toggle:hover {
      background: ${colors.accent}22;
    }
    review-workspace .rw-evidence-toggle.active {
      background: ${colors.accent}22;
      border-color: ${colors.accent};
    }
    review-workspace .rw-recipe-panel {
      padding: ${spacing.sm} ${spacing.lg};
      border-bottom: 1px solid #2a2a44;
      background: ${colors.bgCard};
      overflow-y: auto;
      max-height: 400px;
    }
    review-workspace .rw-recipe-toolbar {
      display: flex;
      gap: 2px;
      margin-bottom: ${spacing.sm};
    }
    review-workspace .rw-recipe-toggle {
      font-family: ${fonts.mono};
      font-size: 10px;
      padding: 2px 8px;
      border: 1px solid transparent;
      border-radius: ${radii.sm};
      background: transparent;
      color: ${colors.textMuted};
      cursor: pointer;
    }
    review-workspace .rw-recipe-toggle.active {
      background: ${colors.accent}12;
      color: ${colors.accent};
      border-color: ${colors.accent}44;
    }
    review-workspace .rw-recipe-pre {
      background: ${colors.bgSurface};
      border: 1px solid #2a2a44;
      border-radius: ${radii.sm};
      padding: 8px;
      font-size: 11px;
      overflow-x: auto;
      color: ${colors.textSecondary};
      margin: 0;
    }
    review-workspace .rw-loading-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 11px;
      background: ${colors.bgCardHover};
      color: ${colors.textSecondary};
      border-bottom: 1px solid #2a2a44;
      flex-shrink: 0;
    }
    review-workspace .rw-loading-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${colors.statusWarn};
      animation: rw-pulse 1s ease-in-out infinite;
    }
    @keyframes rw-pulse {
      0%,
      100% {
        opacity: 0.3;
      }
      50% {
        opacity: 1;
      }
    }
  </style>`;
}
