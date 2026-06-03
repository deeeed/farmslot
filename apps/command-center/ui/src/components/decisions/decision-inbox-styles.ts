import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const decisionInboxStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${unsafeCSS(colors.bgBase)};
  }

  .inbox-header {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.lg)};
    padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
    background: ${unsafeCSS(colors.bgSurface)};
    border-bottom: 1px solid #1e1e36;
    flex-shrink: 0;
  }

  .inbox-title {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeLg)};
    font-weight: 600;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .inbox-count {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textMuted)};
  }

  .inbox-body {
    flex: 1;
    overflow-y: auto;
    padding: ${unsafeCSS(spacing.lg)};
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.md)};
  }

  .inbox-body::-webkit-scrollbar {
    width: 6px;
  }
  .inbox-body::-webkit-scrollbar-thumb {
    background: ${unsafeCSS(colors.textMuted)};
    border-radius: 3px;
  }

  /* Decision card */
  .decision {
    background: ${unsafeCSS(colors.bgCard)};
    border: 1px solid #1e1e36;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.lg)};
    transition: border-color 0.3s;
  }

  .decision.new {
    border-color: ${unsafeCSS(colors.accent)}66;
    animation: glow 2s ease-in-out;
  }

  @keyframes glow {
    0% {
      box-shadow: 0 0 0 0 ${unsafeCSS(colors.accent)}44;
    }
    50% {
      box-shadow: 0 0 12px 2px ${unsafeCSS(colors.accent)}33;
    }
    100% {
      box-shadow: 0 0 0 0 ${unsafeCSS(colors.accent)}00;
    }
  }

  .decision-top {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
  }

  .type-icon {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: ${unsafeCSS(radii.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    font-weight: 700;
    flex-shrink: 0;
  }

  .decision-title {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
  }

  .decision-slot {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textMuted)};
    margin-left: auto;
  }

  .decision-time {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 9px;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .decision-meta {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: 6px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    flex-wrap: wrap;
  }

  .meta-flow {
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: 700;
    font-size: 9px;
    letter-spacing: 0.5px;
  }

  .meta-pr {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
  }
  .meta-pr:hover {
    text-decoration: underline;
  }

  .meta-branch {
    color: ${unsafeCSS(colors.textMuted)};
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta-runner {
    color: ${unsafeCSS(colors.textMuted)};
  }

  .meta-sep {
    color: #333;
  }

  .meta-view-run {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    margin-left: auto;
    cursor: pointer;
    white-space: nowrap;
  }
  .meta-view-run:hover {
    text-decoration: underline;
  }

  .decision-summary {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textPrimary)};
    margin-top: ${unsafeCSS(spacing.sm)};
    line-height: 1.3;
  }

  .decision-desc {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.textSecondary)};
    margin-top: ${unsafeCSS(spacing.md)};
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .check-list {
    margin-top: ${unsafeCSS(spacing.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    line-height: 1.5;
  }

  .check-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .check-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .check-name {
    color: ${unsafeCSS(colors.textSecondary)};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .decision-actions {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    margin-top: ${unsafeCSS(spacing.lg)};
  }

  .retro-card {
    margin-top: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.md)};
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    background: #12121a;
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .retro-what,
  .retro-text,
  .retro-effect-text {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    color: ${unsafeCSS(colors.textSecondary)};
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .retro-row,
  .retro-effect {
    display: grid;
    gap: 3px;
  }

  .retro-label,
  .retro-effect-label {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 700;
  }

  .retro-value {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .retro-details summary {
    cursor: pointer;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
  }

  .retro-open {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    width: fit-content;
  }
  .retro-open:hover {
    text-decoration: underline;
  }

  .retro-effects {
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
    padding-top: ${unsafeCSS(spacing.sm)};
    border-top: 1px solid #1e1e36;
  }

  .decision-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
    border-radius: ${unsafeCSS(radii.sm)};
    border: 1px solid;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .decision-btn:hover {
    opacity: 0.85;
  }
  .decision-btn:disabled {
    opacity: 0.4;
    cursor: wait;
  }

  .decision-open-link {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    padding: ${unsafeCSS(spacing.sm)} 0;
  }

  .decision-open-link:hover {
    text-decoration: underline;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: ${unsafeCSS(spacing.lg)};
  }

  .empty-check {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: ${unsafeCSS(colors.statusOk)}11;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    color: ${unsafeCSS(colors.statusOk)};
  }

  .empty-text {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    color: ${unsafeCSS(colors.textMuted)};
  }

  /* Improvement diff — hosts <diff-review> */
  .improvement-diff-count {
    margin-top: ${unsafeCSS(spacing.md)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .improvement-diff {
    margin-top: ${unsafeCSS(spacing.sm)};
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    overflow: hidden;
  }

  /* Let the diff expand to natural height — avoids dual scroll container */
  .improvement-diff diff-review {
    display: flex;
    flex-direction: column;
  }
  .improvement-diff .dr-body {
    overflow: visible !important;
    flex: 0 0 auto !important;
  }

  .improvement-rationale {
    margin-top: ${unsafeCSS(spacing.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    color: ${unsafeCSS(colors.textSecondary)};
    line-height: 1.4;
    padding: 6px 8px;
    background: #12121a;
    border-radius: ${unsafeCSS(radii.sm)};
    border-left: 2px solid #22d3ee44;
  }

  .improvement-learning {
    margin-top: ${unsafeCSS(spacing.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
  }

  .improvement-learning summary {
    cursor: pointer;
    color: ${unsafeCSS(colors.textMuted)};
    user-select: none;
    padding: 2px 0;
  }

  .improvement-learning summary:hover {
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .improvement-learning-body {
    margin-top: ${unsafeCSS(spacing.sm)};
    color: ${unsafeCSS(colors.textSecondary)};
    line-height: 1.4;
    white-space: pre-wrap;
    padding: 6px 8px;
    background: #12121a;
    border-radius: ${unsafeCSS(radii.sm)};
  }

  /* Chat input */
  .improvement-chat {
    margin-top: ${unsafeCSS(spacing.md)};
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .chat-row {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .chat-input {
    flex: 1;
    background: #0d0d1a;
    border: 1px solid #2a2a44;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 5px 8px;
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    color: ${unsafeCSS(colors.textPrimary)};
    outline: none;
  }

  .chat-input:focus {
    border-color: #22d3ee44;
  }

  .chat-send-btn {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 11px;
    padding: 5px 12px;
    border-radius: ${unsafeCSS(radii.sm)};
    border: 1px solid #22d3ee44;
    background: #22d3ee11;
    color: #22d3ee;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .chat-send-btn:hover {
    opacity: 0.85;
  }
  .chat-send-btn:disabled {
    opacity: 0.4;
    cursor: wait;
  }

  .chat-response {
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    color: ${unsafeCSS(colors.textSecondary)};
    background: #12121a;
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 6px 8px;
    white-space: pre-wrap;
    line-height: 1.4;
    border-left: 2px solid #22d3ee44;
  }

  /* Apply toast */
  .apply-toast {
    margin-top: ${unsafeCSS(spacing.sm)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: 10px;
    padding: 4px 8px;
    border-radius: ${unsafeCSS(radii.sm)};
  }

  .apply-toast.ok {
    background: #00ff8811;
    color: #00ff88;
    border-left: 2px solid #00ff88;
  }

  .apply-toast.fail {
    background: #ff444411;
    color: #ff4444;
    border-left: 2px solid #ff4444;
  }
`;
