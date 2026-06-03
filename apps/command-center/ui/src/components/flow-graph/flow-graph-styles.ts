import { css, unsafeCSS } from 'lit';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

export const flowGraphStyles = css`
  :host {
    display: block;
    height: 100%;
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .fg-container {
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.lg)};
    height: 100%;
    overflow: hidden;
  }

  /* Selector bar */
  .fg-selector {
    display: flex;
    gap: ${unsafeCSS(spacing.lg)};
    align-items: center;
    flex-wrap: wrap;
    padding: 0 ${unsafeCSS(spacing.md)};
  }
  .fg-pill-group {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    align-items: center;
  }
  .fg-pill-label {
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: ${unsafeCSS(spacing.sm)};
  }
  .fg-pill {
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    background: transparent;
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s,
      color 0.15s;
  }
  .fg-pill:hover {
    background: ${unsafeCSS(colors.bgCard)};
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .fg-pill.active {
    background: ${unsafeCSS(colors.accent)}22;
    border-color: ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
  }

  /* Legend */
  .fg-legend {
    display: flex;
    gap: ${unsafeCSS(spacing.md)};
    align-items: center;
    padding: 0 ${unsafeCSS(spacing.md)};
  }
  .fg-legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .fg-legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  /* SVG viewport */
  .fg-svg-wrap {
    flex: 1 1 auto;
    overflow: hidden;
    min-height: 180px;
  }
  .fg-svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* Lane labels */
  .lane-label {
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .lane-sep {
    stroke-dasharray: 4 4;
  }

  /* Nodes */
  .fg-node {
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .fg-node:hover rect,
  .fg-node:hover polygon {
    filter: brightness(1.2);
  }
  .fg-node-label {
    font-size: 10px;
    font-weight: 600;
  }
  .fg-node-annotation {
    font-size: 7px;
    font-weight: 500;
  }

  /* Arrows */
  .fg-edge {
    fill: none;
    stroke-width: 1.5;
    transition: stroke 0.3s;
  }
  .fg-edge-label {
    font-size: 8px;
  }

  /* Detail panel */
  .fg-detail {
    background: ${unsafeCSS(colors.bgCard)};
    border-radius: 6px;
    padding: ${unsafeCSS(spacing.lg)};
    margin: 0 ${unsafeCSS(spacing.md)};
    flex: 0 1 auto;
    overflow-y: auto;
    min-height: 120px;
  }
  .fg-detail-title {
    font-size: 12px;
    font-weight: 700;
    color: ${unsafeCSS(colors.textPrimary)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.md)};
  }
  .fg-detail-kind {
    font-size: 9px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .fg-detail-desc {
    font-size: 11px;
    color: ${unsafeCSS(colors.textSecondary)};
    line-height: 1.5;
  }
  .fg-detail-annotation {
    font-size: 10px;
    color: ${unsafeCSS(colors.statusWarn)};
    margin-top: ${unsafeCSS(spacing.sm)};
    font-style: italic;
  }
  .fg-neighborhood {
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid ${unsafeCSS(colors.bgSurface)};
    overflow-x: auto;
  }
`;
