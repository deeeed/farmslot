import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import { readyWorkspaceReviewModalStyles } from './ready-workspace-review-modal-styles.js';

export function readyWorkspaceLightStyles(): string {
  return `
      ready-workspace {
        display: flex; flex-direction: column; height: 100%;
        font-family: ${fonts.mono}; font-size: ${fonts.sizeSm};
        color: ${colors.textPrimary}; background: ${colors.bgBase};
      }
      ready-workspace .rdy-empty {
        display: flex; align-items: center; justify-content: center;
        height: 100%; color: ${colors.textMuted};
      }
      ready-workspace .rdy-top-bar {
        display: flex; align-items: center; gap: ${spacing.md};
        padding: ${spacing.sm} ${spacing.lg};
        background: ${colors.bgCard}; border-bottom: 1px solid #2a2a44; flex-shrink: 0;
      }
      ready-workspace .rdy-branch {
        font-weight: 700; font-size: 12px; color: ${colors.accent};
      }
      ready-workspace .rdy-pr-link {
        color: ${colors.accent}; text-decoration: none; font-size: 12px;
      }
      ready-workspace .rdy-local-only {
        color: ${colors.statusWarn}; border: 1px solid ${colors.statusWarn}66;
        border-radius: ${radii.sm}; padding: 2px 6px;
      }
      ready-workspace .rdy-pr-link:hover { text-decoration: underline; }
      ready-workspace .rdy-diff-stat {
        font-size: 11px; display: flex; gap: 4px; align-items: center;
        border: 1px solid transparent; background: transparent; padding: 2px 4px;
        border-radius: ${radii.sm}; font-family: ${fonts.mono}; cursor: pointer;
      }
      ready-workspace .rdy-diff-stat:hover:not(:disabled) { border-color: ${colors.accent}55; background: ${colors.accent}12; }
      ready-workspace .rdy-diff-stat:disabled { cursor: default; opacity: 0.8; }
      ready-workspace .rdy-stat-add { color: ${colors.statusOk}; }
      ready-workspace .rdy-stat-del { color: ${colors.statusFail}; }
      ready-workspace .rdy-stat-files { color: ${colors.textMuted}; }
      ready-workspace .rdy-sr-badge {
        font-size: 10px; font-weight: 700; padding: 2px 8px;
        border-radius: ${radii.sm}; text-transform: uppercase; letter-spacing: 0.04em;
      }
      ready-workspace .rdy-action-feedback {
        min-width: 220px;
        max-width: 360px;
        font-size: 11px;
        color: ${colors.textMuted};
      }
      ready-workspace .rdy-action-feedback.success {
        color: ${colors.statusOk};
      }
      ready-workspace .rdy-action-feedback.error {
        color: ${colors.statusFail};
      }
      ready-workspace .rdy-spacer { flex: 1; }
      ready-workspace .rdy-btn {
        font-family: ${fonts.mono}; font-size: 12px; font-weight: 600;
        padding: 6px 16px; border-radius: ${radii.md};
        cursor: pointer; border: none; transition: opacity 0.15s;
      }
      ready-workspace .rdy-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      ready-workspace .rdy-btn:hover:not(:disabled) { opacity: 0.85; }
      ready-workspace .rdy-btn-primary { background: ${colors.accent}; color: #fff; }
      ready-workspace .rdy-btn-secondary { background: #333344; color: ${colors.textSecondary}; }
      ready-workspace .rdy-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.68);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      ${readyWorkspaceReviewModalStyles()}
      ready-workspace .rdy-package-summary {
        display: grid;
        gap: 7px;
        font-size: 11px;
        color: ${colors.textMuted};
      }
      ready-workspace .rdy-review-strip {
        display: flex;
        flex-wrap: wrap;
        gap: ${spacing.sm};
        align-items: center;
        font-size: 11px;
        color: ${colors.textMuted};
      }
      ready-workspace .rdy-package-summary strong { color: ${colors.textPrimary}; }
      ready-workspace .rdy-package-header,
      ready-workspace .rdy-package-title,
      ready-workspace .rdy-package-actions,
      ready-workspace .rdy-package-facts {
        display: flex;
        align-items: center;
        gap: ${spacing.sm};
        flex-wrap: wrap;
      }
      ready-workspace .rdy-package-header {
        justify-content: space-between;
      }
      ready-workspace .rdy-package-title > strong {
        font-size: 12px;
      }
      ready-workspace .rdy-package-status {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: ${spacing.sm};
        border: 1px solid #2a2a44;
        border-radius: ${radii.sm};
        padding: 6px 8px;
      }
      ready-workspace .rdy-package-status.ready {
        border-color: ${colors.statusOk}55;
        background: ${colors.statusOk}0d;
      }
      ready-workspace .rdy-package-status.attention {
        border-color: ${colors.statusWarn}66;
        background: ${colors.statusWarn}0d;
      }
      ready-workspace .rdy-package-status.ready > strong { color: ${colors.statusOk}; }
      ready-workspace .rdy-package-status.attention > strong { color: ${colors.statusWarn}; }
      ready-workspace .rdy-package-facts > span {
        border: 1px solid #2a2a44;
        border-radius: 999px;
        padding: 2px 7px;
      }
      ready-workspace .rdy-refresh-package {
        border: 1px solid ${colors.accent};
        border-radius: ${radii.sm};
        background: ${colors.accent}22;
        color: ${colors.accent};
        cursor: pointer;
        font-family: ${fonts.mono};
        font-size: 11px;
        font-weight: 600;
        padding: 5px 9px;
      }
      ready-workspace .rdy-review-flow-button {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        border: 1px solid ${colors.accent};
        border-radius: ${radii.sm};
        background: ${colors.accent}18;
        color: ${colors.accent};
        font-family: ${fonts.mono};
        font-weight: 700;
        padding: 6px 10px;
        cursor: pointer;
      }
      ready-workspace .rdy-review-flow-button span {
        border-left: 1px solid ${colors.accent}55;
        padding-left: 7px;
        color: ${colors.textSecondary};
        font-size: 10px;
        font-weight: 500;
      }
      ready-workspace .rdy-refresh-package:hover:not(:disabled) {
        background: ${colors.accent}33;
      }
      ready-workspace .rdy-refresh-package:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      ready-workspace .rdy-package-details {
        display: grid;
        gap: ${spacing.sm};
        min-height: 0;
        overflow: auto;
        padding-right: 4px;
      }
      ready-workspace .rdy-cockpit-link,
      ready-workspace .rdy-inline-diff-stat {
        border: 1px solid transparent;
        border-radius: ${radii.sm};
        background: transparent;
        color: ${colors.textSecondary};
        cursor: pointer;
        font-family: ${fonts.mono};
        font-size: 11px;
        padding: 2px 5px;
      }
      ready-workspace .rdy-cockpit-link:hover,
      ready-workspace .rdy-inline-diff-stat:hover:not(.disabled) {
        border-color: ${colors.accent}55;
        background: ${colors.accent}12;
        color: ${colors.textPrimary};
      }
      ready-workspace .rdy-inline-diff-stat {
        display: inline-flex;
        gap: 4px;
        align-items: center;
        margin-left: 6px;
      }
      ready-workspace .rdy-inline-diff-stat.disabled {
        cursor: default;
        opacity: 0.75;
      }
      ready-workspace .rdy-draft-grid {
        display: grid;
        grid-template-columns: minmax(160px, 0.7fr);
        gap: ${spacing.sm};
      }
      ready-workspace .rdy-publish-target-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        color: ${colors.textMuted};
        font-size: 11px;
      }
      ready-workspace .rdy-target-toggle {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        border: 1px solid #2a2a44;
        border-radius: ${radii.md};
        background: ${colors.bgBase};
        padding: 3px;
      }
      ready-workspace .rdy-target-toggle button {
        border: 0;
        border-radius: ${radii.sm};
        background: transparent;
        color: ${colors.textMuted};
        font-family: ${fonts.mono};
        font-size: 11px;
        padding: 6px 10px;
        cursor: pointer;
      }
      ready-workspace .rdy-target-toggle button.active {
        background: ${colors.accent}18;
        color: ${colors.accent};
      }
      ready-workspace .rdy-review-pill {
        border: 1px solid ${colors.accent}55;
        border-radius: ${radii.sm};
        padding: 2px 6px;
        color: ${colors.textSecondary};
      }
      ready-workspace .rdy-review-pill.warn {
        border-color: ${colors.statusWarn}66;
        color: ${colors.statusWarn};
      }
      ready-workspace .rdy-review-card {
        border: 1px solid #2a2a44;
        border-radius: ${radii.sm};
        background: ${colors.bgBase};
        padding: ${spacing.sm};
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      ready-workspace .rdy-review-card.pass { border-color: ${colors.statusOk}55; }
      ready-workspace .rdy-review-card.warn { border-color: ${colors.statusWarn}66; }
      ready-workspace .rdy-review-card-head {
        display: flex;
        justify-content: space-between;
        gap: ${spacing.sm};
        align-items: center;
        font-size: 11px;
      }
      ready-workspace .rdy-review-card-head strong { color: ${colors.textPrimary}; }
      ready-workspace .rdy-review-card-head span {
        color: ${colors.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 9px;
      }
      ready-workspace .rdy-review-card-meta {
        color: ${colors.textSecondary};
        font-size: 11px;
        line-height: 1.4;
      }
      ready-workspace .rdy-review-stale {
        color: ${colors.statusFail};
        border: 1px solid ${colors.statusFail}66;
        border-radius: ${radii.sm};
        padding: 1px 5px;
        margin-left: 6px;
        text-transform: uppercase;
        font-size: 9px;
      }
      ready-workspace .rdy-review-artifacts {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      ready-workspace .rdy-publish-evidence-card {
        grid-column: 1 / -1;
      }
      ready-workspace .rdy-publish-evidence-list {
        display: grid;
        gap: 4px;
      }
      ready-workspace .rdy-publish-evidence-row {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        color: ${colors.textSecondary};
        font-size: 11px;
      }
      ready-workspace .rdy-publish-evidence-row > span {
        color: ${colors.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 9px;
      }
      ready-workspace .rdy-publish-evidence-row.included > span {
        color: ${colors.statusOk};
      }
      ready-workspace .rdy-publish-evidence-row.excluded > span {
        color: ${colors.statusWarn};
      }
      ready-workspace .rdy-publish-evidence-row code {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: ${colors.textPrimary};
      }
      ready-workspace .rdy-publish-evidence-row small {
        color: ${colors.textMuted};
      }
      ready-workspace .rdy-recovery-overlay {
        position: absolute;
        inset: 0;
        z-index: 15;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(10, 10, 15, 0.72);
        backdrop-filter: blur(2px);
      }
      ready-workspace .rdy-recovery-card {
        width: min(360px, calc(100% - 24px));
        padding: 16px;
        border-radius: ${radii.md};
        border: 1px solid ${colors.accent}44;
        background: ${colors.bgSurface};
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      ready-workspace .rdy-recovery-eyebrow {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: ${colors.accent};
      }
      ready-workspace .rdy-recovery-title {
        font-size: 13px;
        font-weight: 700;
        color: ${colors.textPrimary};
      }
      ready-workspace .rdy-recovery-copy {
        font-size: 12px;
        line-height: 1.5;
        color: ${colors.textSecondary};
      }
      ready-workspace .rdy-recovery-actions {
        display: flex;
        justify-content: flex-end;
      }
      ready-workspace .rdy-recovery-btn {
        font-family: ${fonts.mono};
        font-size: 11px;
        padding: 6px 10px;
        border-radius: ${radii.sm};
        border: 1px solid ${colors.accent}44;
        background: ${colors.accent}22;
        color: ${colors.accent};
        cursor: pointer;
      }
      ready-workspace .rdy-report {
        overflow-y: auto; min-height: 80px;
      }
      ready-workspace .rdy-md-section {
        padding: ${spacing.md} ${spacing.xl}; font-size: 12px; line-height: 1.6;
      }
      ready-workspace .rdy-md-section h1, ready-workspace .rdy-md-section h2,
      ready-workspace .rdy-md-section h3 { color: ${colors.textPrimary}; margin: 10px 0 4px; }
      ready-workspace .rdy-md-section h2 { font-size: 14px; }
      ready-workspace .rdy-md-section h3 { font-size: 12px; }
      ready-workspace .rdy-md-section p { margin: 4px 0; }
      ready-workspace .rdy-md-section pre {
        background: ${colors.bgSurface}; border: 1px solid #2a2a44;
        border-radius: ${radii.sm}; padding: 6px 8px; font-size: 11px; overflow-x: auto;
      }
      ready-workspace .rdy-md-section code {
        background: ${colors.bgSurface}; padding: 1px 4px; border-radius: 2px;
        font-size: 11px; color: ${colors.accent};
      }
      ready-workspace .rdy-md-section pre code { background: none; padding: 0; color: ${colors.textSecondary}; }
      ready-workspace .rdy-md-section a { color: ${colors.accent}; text-decoration: none; }
      ready-workspace .rdy-md-section strong { color: ${colors.textPrimary}; }
      ready-workspace .rdy-md-section ul, ready-workspace .rdy-md-section ol { margin: 4px 0; padding-left: 18px; }
      ready-workspace .rdy-md-empty {
        display: flex; align-items: center; justify-content: center;
        height: 100%; color: ${colors.textMuted}; font-size: 12px;
      }

      ready-workspace .rdy-learnings {
        border-top: 1px solid #2a2a44;
      }
      ready-workspace .rdy-learnings-header {
        padding: 6px ${spacing.xl}; cursor: pointer; font-size: 11px;
        font-weight: 700; color: ${colors.textMuted}; text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      ready-workspace .rdy-learnings-header:hover {
        color: ${colors.textSecondary};
      }

      ready-workspace .rdy-resize {
        height: 4px; background: #2a2a44; cursor: row-resize; flex-shrink: 0;
      }
      ready-workspace .rdy-resize:hover { background: ${colors.accent}44; }

      ready-workspace .rdy-bottom {
        display: flex; flex-direction: column; min-height: 100px; overflow: hidden;
      }
      ready-workspace .rdy-package-evidence-section {
        flex-shrink: 0;
      }
      ready-workspace .rdy-package-evidence-collapsed-hint {
        padding: 0 ${spacing.sm} ${spacing.sm};
      }
      ready-workspace .rdy-tab-pane-host {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }
      ready-workspace .rdy-tab-bar {
        display: flex; gap: 1px; background: ${colors.bgCard};
        border-bottom: 1px solid #2a2a44; padding: 2px ${spacing.sm}; flex-shrink: 0;
      }
      ready-workspace .rdy-tab {
        padding: 4px 12px; border: none; background: transparent;
        color: ${colors.textMuted}; font-family: ${fonts.mono}; font-size: 11px;
        cursor: pointer; border-radius: 3px;
      }
      ready-workspace .rdy-tab:hover { background: ${colors.bgSurface}; color: ${colors.textSecondary}; }
      ready-workspace .rdy-tab.active { background: ${colors.accent}18; color: ${colors.textPrimary}; }

      ready-workspace .rdy-tab-empty {
        display: flex; align-items: center; justify-content: center;
        flex: 1; color: ${colors.textMuted}; font-size: 12px; min-height: 100px;
      }

      ready-workspace .rdy-evidence-tab {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        overflow-y: auto;
      }

      ready-workspace .rdy-pr-preview {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
        overflow: auto;
      }
      ready-workspace .rdy-pr-preview-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: ${spacing.md};
        padding: ${spacing.md} ${spacing.xl};
        border-bottom: 1px solid #2a2a44;
        background: ${colors.bgCard};
      }
      ready-workspace .rdy-pr-preview-eyebrow {
        color: ${colors.textMuted};
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 4px;
      }
      ready-workspace .rdy-pr-preview h3 {
        margin: 0;
        color: ${colors.textPrimary};
        font-size: 14px;
      }
      ready-workspace .rdy-pr-preview-body {
        border-bottom: 1px solid #2a2a44;
      }
      ready-workspace .rdy-pr-preview-evidence {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      ready-workspace .rdy-input-tab {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: ${spacing.md};
        display: grid;
        gap: ${spacing.md};
      }
      ready-workspace .rdy-input-card {
        border: 1px solid #2a2a44;
        border-radius: ${radii.md};
        background: ${colors.bgSurface};
        padding: ${spacing.md};
        display: grid;
        gap: ${spacing.sm};
        min-width: 0;
      }
      ready-workspace .rdy-input-artifact-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: ${spacing.md};
        align-items: start;
      }
      ready-workspace .rdy-input-artifact-card {
        border: 1px solid #2a2a44;
        border-radius: ${radii.md};
        background: ${colors.bgSurface};
        color: ${colors.textSecondary};
        font-family: ${fonts.mono};
        text-align: left;
        padding: ${spacing.md};
        display: grid;
        gap: 7px;
        cursor: pointer;
        min-width: 0;
        min-height: 170px;
        align-content: start;
      }
      ready-workspace .rdy-input-artifact-card:hover {
        border-color: ${colors.accent}77;
        background: ${colors.accent}0f;
      }
      ready-workspace .rdy-input-artifact-card > span {
        align-self: start;
        justify-self: start;
        border: 1px solid ${colors.accent}66;
        border-radius: 999px;
        padding: 2px 8px;
        color: ${colors.accent};
        background: ${colors.accent}14;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 800;
      }
      ready-workspace .rdy-input-artifact-card strong {
        color: ${colors.textPrimary};
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      ready-workspace .rdy-input-artifact-card small {
        color: ${colors.textMuted};
        line-height: 1.45;
      }
      ready-workspace .rdy-input-artifact-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      ready-workspace .rdy-input-artifact-meta code {
        background: ${colors.bgBase};
        color: ${colors.textSecondary};
        border-radius: 999px;
        padding: 2px 6px;
        font-size: 10px;
      }
      ready-workspace .rdy-input-viewer {
        width: min(900px, calc(100vw - 48px));
        max-height: calc(100vh - 64px);
        background: ${colors.bgBase};
        border: 1px solid #2a2a44;
        border-radius: ${radii.lg};
        box-shadow: 0 24px 80px rgba(0,0,0,0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      ready-workspace .rdy-input-viewer-head {
        display: flex;
        justify-content: space-between;
        gap: ${spacing.md};
        align-items: flex-start;
        padding: ${spacing.md};
        border-bottom: 1px solid #2a2a44;
        background: ${colors.bgCard};
      }
      ready-workspace .rdy-input-viewer-head h3 {
        margin: 2px 0 0;
        color: ${colors.textPrimary};
        font-size: 15px;
      }
      ready-workspace .rdy-input-viewer-head p {
        margin: 5px 0 0;
        color: ${colors.textMuted};
        font-size: 11px;
      }
      ready-workspace .rdy-input-viewer-body {
        overflow: auto;
        min-height: 0;
        padding: ${spacing.md};
      }
      ready-workspace .rdy-input-card-head {
        display: flex;
        justify-content: space-between;
        gap: ${spacing.md};
        align-items: flex-start;
      }
      ready-workspace .rdy-input-card h3 {
        margin: 2px 0 0;
        color: ${colors.textPrimary};
        font-size: 14px;
        line-height: 1.35;
      }
      ready-workspace .rdy-input-eyebrow,
      ready-workspace .rdy-input-section-title {
        color: ${colors.textMuted};
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
      }
      ready-workspace .rdy-input-links,
      ready-workspace .rdy-input-chips {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
      }
      ready-workspace .rdy-input-links a,
      ready-workspace .rdy-input-links span,
      ready-workspace .rdy-input-chips span {
        border: 1px solid ${colors.textMuted}44;
        border-radius: 999px;
        padding: 2px 8px;
        color: ${colors.textSecondary};
        font-size: 10px;
        text-decoration: none;
      }
      ready-workspace .rdy-input-links a {
        border-color: ${colors.accent}66;
        color: ${colors.accent};
      }
      ready-workspace .rdy-input-md {
        padding: 0;
      }
      ready-workspace .rdy-input-comments {
        display: grid;
        gap: 6px;
      }
      ready-workspace .rdy-input-comments pre,
      ready-workspace .rdy-input-pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-x: auto;
        background: ${colors.bgBase};
        border: 1px solid #2a2a44;
        border-radius: ${radii.sm};
        padding: ${spacing.sm};
        color: ${colors.textSecondary};
        font-family: ${fonts.mono};
        font-size: 11px;
        line-height: 1.5;
      }
      ready-workspace .rdy-input-card summary {
        cursor: pointer;
        color: ${colors.textPrimary};
        font-weight: 700;
      }
      ready-workspace .rdy-input-card summary span {
        margin-left: 8px;
        color: ${colors.textMuted};
        font-weight: 400;
        font-size: 10px;
      }
      ready-workspace .rdy-input-card details[open] summary {
        margin-bottom: ${spacing.sm};
      }
      ready-workspace .rdy-input-linked,
      ready-workspace .rdy-input-kv {
        display: grid;
        gap: 6px;
      }
      ready-workspace .rdy-input-linked div {
        display: flex;
        gap: 8px;
        align-items: baseline;
        color: ${colors.textSecondary};
      }
      ready-workspace .rdy-input-linked a {
        color: ${colors.accent};
        text-decoration: none;
      }
      ready-workspace .rdy-input-kv {
        grid-template-columns: max-content minmax(0, 1fr);
      }
      ready-workspace .rdy-input-kv span {
        color: ${colors.textMuted};
      }
      ready-workspace .rdy-input-kv code {
        color: ${colors.textSecondary};
        background: ${colors.bgBase};
        border-radius: 3px;
        padding: 1px 4px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      ready-workspace .rdy-diff-area {
        display: flex; flex-direction: column; flex: 1; overflow: hidden;
      }
      ready-workspace .rdy-file-tabs {
        display: flex; flex-wrap: nowrap; gap: 1px; background: ${colors.bgCard};
        border-bottom: 1px solid #2a2a44; padding: 2px ${spacing.sm};
        flex-shrink: 0; overflow-x: auto;
      }
      ready-workspace .rdy-ft {
        display: flex; align-items: center; gap: 4px; padding: 3px 8px; border: none;
        background: transparent; color: ${colors.textMuted}; font-family: ${fonts.mono};
        font-size: 11px; cursor: pointer; border-radius: 3px; white-space: nowrap;
      }
      ready-workspace .rdy-ft:hover { background: ${colors.bgSurface}; color: ${colors.textSecondary}; }
      ready-workspace .rdy-ft.selected { background: ${colors.accent}18; color: ${colors.textPrimary}; }
      ready-workspace .rdy-diff-content {
        flex: 1; overflow: hidden; display: flex; flex-direction: column;
      }
      ready-workspace .rdy-diff-content diff-review { flex: 1; min-height: 0; }

      ready-workspace .rdy-recipe-view {
        flex: 1; display: flex; flex-direction: column; overflow: hidden;
      }
      ready-workspace .rdy-recipe-toolbar {
        display: flex; gap: 4px; padding: ${spacing.sm};
        border-bottom: 1px solid #2a2a44; flex: 0 0 auto; align-items: center;
      }
      ready-workspace .rdy-recipe-toggle {
        background: none; border: 1px solid #2a2a44; border-radius: ${radii.sm};
        color: ${colors.textSecondary}; font-size: 10px; padding: 2px 10px; cursor: pointer;
      }
      ready-workspace .rdy-recipe-toggle.active {
        background: ${colors.accent}22; border-color: ${colors.accent};
        color: ${colors.accent};
      }
      ready-workspace .rdy-recipe-graph-wrap {
        flex: 1; overflow: hidden;
      }
      ready-workspace .rdy-recipe-pre {
        flex: 1; overflow: auto; background: ${colors.bgSurface}; border: none;
        padding: ${spacing.md}; font-size: 11px; line-height: 1.5; margin: 0;
        color: ${colors.textSecondary};
      }
      ready-workspace .rdy-recipe-pre code { color: ${colors.textSecondary}; }

      ready-workspace .rdy-artifact-groups {
        display: flex;
        flex-direction: column;
        gap: ${spacing.sm};
        min-height: 0;
        overflow-y: auto;
        flex: 1;
        padding: ${spacing.md};
      }
      ready-workspace .rdy-evidence-tab > .rdy-artifact-groups {
        flex: 0 0 auto;
        overflow: visible;
      }
      ready-workspace .rdy-artifact-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: ${spacing.sm};
        flex-wrap: wrap;
      }
      ready-workspace .rdy-evidence-selection {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: ${spacing.sm};
        padding: ${spacing.sm} ${spacing.md};
        border-bottom: 1px solid #2a2a44;
        background: ${colors.bgCard};
        color: ${colors.textMuted};
        font-size: 11px;
        flex-wrap: wrap;
      }
      ready-workspace .rdy-evidence-selection strong {
        color: ${colors.textPrimary};
        margin-right: 8px;
      }
      ready-workspace .rdy-evidence-selection-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      ready-workspace .rdy-artifact-filters {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      ready-workspace .rdy-artifact-filter-stack {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      ready-workspace .rdy-artifact-filter {
        background: transparent;
        border: 1px solid ${colors.textMuted}44;
        border-radius: 999px;
        color: ${colors.textMuted};
        cursor: pointer;
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 2px 9px;
      }
      ready-workspace .rdy-artifact-filter span {
        color: ${colors.textSecondary};
      }
      ready-workspace .rdy-artifact-filter.active,
      ready-workspace .rdy-artifact-filter.compare {
        border-color: ${colors.accent};
        color: ${colors.accent};
        background: ${colors.accent}18;
      }
      ready-workspace .rdy-artifact-filter:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      ready-workspace .rdy-artifact-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      ready-workspace .rdy-artifact-group-title {
        display: flex;
        gap: ${spacing.sm};
        align-items: center;
        color: ${colors.textMuted};
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      ready-workspace .rdy-artifacts-grid {
        display: flex; flex-wrap: wrap; gap: ${spacing.md};
      }
      ready-workspace .rdy-artifact-card {
        background: ${colors.bgSurface}; border: 1px solid #2a2a44;
        border-radius: ${radii.sm}; padding: ${spacing.sm} ${spacing.md};
        min-width: 180px; max-width: 260px;
        color: inherit;
        font-family: ${fonts.mono};
        text-align: left;
        cursor: default;
        position: relative;
      }
      ready-workspace .rdy-artifact-card.excluded {
        opacity: 0.48;
        border-style: dashed;
      }
      ready-workspace .rdy-artifact-type-badge {
        display: inline-flex;
        align-items: center;
        border: 1px solid ${colors.textMuted}44;
        border-radius: 999px;
        padding: 1px 6px;
        margin: 0 0 6px 0;
        color: ${colors.textSecondary};
        background: ${colors.bgBase};
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.05em;
      }
      ready-workspace .rdy-artifact-type-badge.video {
        border-color: ${colors.statusWarn}77;
        color: ${colors.statusWarn};
        background: ${colors.statusWarn}16;
      }
      ready-workspace .rdy-artifact-type-badge.image {
        border-color: ${colors.statusOk}66;
        color: ${colors.statusOk};
        background: ${colors.statusOk}12;
      }
      ready-workspace .rdy-artifact-type-badge.markdown,
      ready-workspace .rdy-artifact-type-badge.json,
      ready-workspace .rdy-artifact-type-badge.diff {
        border-color: ${colors.accent}66;
        color: ${colors.accent};
        background: ${colors.accent}14;
      }
      ready-workspace .rdy-artifact-card.clickable {
        cursor: pointer;
      }
      ready-workspace .rdy-artifact-card.clickable:hover {
        border-color: ${colors.accent}77;
      }
      ready-workspace .rdy-artifact-card.compact {
        min-width: 0;
        max-width: 190px;
        padding: 5px 7px;
      }
      ready-workspace .rdy-artifact-select {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-bottom: 6px;
        color: ${colors.textSecondary};
        font-size: 10px;
        cursor: pointer;
        user-select: none;
      }
      ready-workspace .rdy-artifact-select input {
        accent-color: ${colors.accent};
      }
      ready-workspace .rdy-artifact-name {
        font-size: 11px; color: ${colors.textSecondary};
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      ready-workspace .rdy-artifact-purpose {
        font-size: 9px; font-weight: 700; text-transform: uppercase;
        color: ${colors.accent}; margin-right: 6px;
      }
      ready-workspace .rdy-artifact-size {
        font-size: 9px; color: ${colors.textMuted}; margin-left: 4px;
      }
      ready-workspace .rdy-artifact-type {
        font-size: 9px; color: ${colors.textMuted}; margin-top: 2px;
      }
      ready-workspace .rdy-media-card {
        min-width: 200px; max-width: 340px; width: auto;
      }
      ready-workspace .rdy-media-preview {
        width: 100%; max-height: 200px; object-fit: contain;
        border-radius: ${radii.sm}; margin-bottom: ${spacing.sm};
        background: #000;
      }
      ready-workspace .rdy-artifact-card.compact .rdy-media-preview {
        max-height: 80px;
        margin-bottom: 4px;
      }
      ready-workspace .rdy-ci-checks {
        display: flex; gap: 6px; flex-wrap: wrap;
      }
      ready-workspace .rdy-ci-check {
        font-size: 11px; font-weight: 600;
      }
      ready-workspace .rdy-ac-list {
        margin: 4px 0 8px; padding-left: 28px;
        font-size: 12px; line-height: 1.6;
      }
      ready-workspace .rdy-ac-item {
        color: ${colors.textSecondary}; margin: 2px 0;
      }
    `;
}
