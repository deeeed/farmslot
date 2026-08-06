import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export const runPipelineStyles = css`
  :host {
    display: block;
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .pipeline-wrap {
    position: relative;
  }
  .review-recovery {
    margin: 0 0 ${unsafeCSS(spacing.sm)};
    padding: 6px 8px;
    border: 1px solid ${unsafeCSS(colors.statusWarn)}66;
    border-radius: ${unsafeCSS(radii.sm)};
    color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.statusWarn)}12;
    font-size: 11px;
  }
  .review-recovery.operator-required {
    border-color: ${unsafeCSS(colors.statusFail)}66;
    color: ${unsafeCSS(colors.statusFail)};
    background: ${unsafeCSS(colors.statusFail)}12;
  }

  .pipeline-svg {
    display: block;
    height: auto;
    max-width: 100%;
  }

  .lane-label {
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .lane-sep {
    stroke-dasharray: 4 4;
  }

  .node rect {
    stroke-width: 2;
    transition:
      fill 0.3s,
      stroke 0.3s;
  }
  .node-label {
    font-size: 10px;
    font-weight: 600;
  }
  .node-meta {
    font-size: 8px;
  }
  .node-elapsed {
    font-size: 8px;
  }
  .node-count {
    font-size: 8px;
  }

  .arrow {
    stroke-width: 2;
    fill: none;
    transition: stroke 0.3s;
  }
  .loop-label {
    paint-order: stroke;
    stroke: ${unsafeCSS(colors.bgBase)};
    stroke-width: 3px;
    stroke-linejoin: round;
  }

  .progress-bg {
    rx: 2;
  }
  .progress-fill {
    rx: 2;
    transition: width 0.5s ease;
  }

  @keyframes node-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }
  .node-running-anim {
    animation: node-pulse 2s ease-in-out infinite;
  }
  .node-blocked-anim {
    animation: node-blocked 1.2s ease-in-out infinite;
  }
  @keyframes node-blocked {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.6;
    }
  }

  @keyframes diamond-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  .decision-pending {
    animation: diamond-pulse 1.5s ease-in-out infinite;
  }
  .decision-btn {
    cursor: pointer;
  }
  .decision-btn:hover rect {
    stroke-width: 2;
  }

  .controls {
    position: absolute;
    top: ${unsafeCSS(spacing.sm)};
    right: ${unsafeCSS(spacing.md)};
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    z-index: 1;
  }
  .ctrl-btn {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid;
    background: ${unsafeCSS(colors.bgCard)};
    font-family: inherit;
    font-size: 10px;
    cursor: pointer;
    opacity: 0.8;
  }
  .ctrl-btn:hover {
    opacity: 1;
  }
  .ctrl-btn:disabled {
    cursor: wait;
    opacity: 0.55;
  }
  .ctrl-pending {
    color: ${unsafeCSS(colors.statusWarn)};
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .ctrl-pause {
    border-color: ${unsafeCSS(colors.statusWarn)};
    color: ${unsafeCSS(colors.statusWarn)};
  }
  .ctrl-resume {
    border-color: ${unsafeCSS(colors.statusOk)};
    color: ${unsafeCSS(colors.statusOk)};
  }
  .ctrl-cancel {
    border-color: ${unsafeCSS(colors.statusFail)};
    color: ${unsafeCSS(colors.statusFail)};
  }

  .run-summary {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
    padding: 6px ${unsafeCSS(spacing.md)};
    margin-top: 4px;
    border-top: 1px solid ${unsafeCSS(colors.bgCard)};
    font-size: 10px;
  }
  .summary-outcome {
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .summary-item {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .summary-cost {
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
  }
  .summary-warn {
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .monitor-detail {
    margin-top: ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    cursor: default;
  }
  .monitor-detail-header {
    font-size: 11px;
    font-weight: 600;
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: ${unsafeCSS(spacing.sm)};
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .monitor-close {
    background: none;
    border: none;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    padding: 0 4px;
  }
  .monitor-close:hover {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .phase {
    margin-bottom: ${unsafeCSS(spacing.sm)};
  }
  .phase-header {
    font-size: 11px;
    font-weight: 600;
    color: ${unsafeCSS(colors.textPrimary)};
    margin-bottom: 2px;
    display: flex;
    justify-content: space-between;
  }
  .phase-count {
    color: ${unsafeCSS(colors.textMuted)};
    font-weight: 400;
  }
  .substep {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    padding: 1px 0 1px 12px;
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .substep-icon {
    width: 12px;
    text-align: center;
    flex-shrink: 0;
  }
  .substep.done .substep-icon {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .substep.running .substep-icon {
    color: #3b82f6;
  }
  .substep.done {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .substep.running {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
  }

  .complete-pill {
    font-size: 7px;
    font-weight: 600;
  }
  .cost-badge {
    font-size: 8px;
  }
`;
