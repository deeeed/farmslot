import { css, unsafeCSS } from 'lit';

import { colors, radii, spacing } from '../../styles/theme-tokens.js';

/** Shared run-selector row styles (family observability pages). */
export const runSelectorStyles = css`
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
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    appearance: none;
  }

  .run-item:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
  }

  .run-item.selected {
    border-color: ${unsafeCSS(colors.accent)}66;
    background: ${unsafeCSS(colors.accent)}11;
  }

  .run-item.terminal-alert {
    border-left: 3px solid var(--run-status-color);
  }

  .run-item-top {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    flex-wrap: wrap;
    align-items: center;
  }

  .run-item-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
    margin-bottom: 4px;
  }

  .run-item-reason {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: 11px;
    margin-bottom: 5px;
    line-height: 1.35;
  }

  .run-item-meta {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 11px;
    word-break: break-word;
  }

  .run-item-cta {
    color: ${unsafeCSS(colors.accent)};
    font-size: 11px;
    margin-top: 6px;
  }

  .run-item-pipeline {
    margin-top: 6px;
    max-width: 100%;
    overflow: hidden;
  }

  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1.3;
    white-space: nowrap;
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

  .badge.lane {
    border: 1px solid ${unsafeCSS(colors.textMuted)}55;
    color: ${unsafeCSS(colors.textMuted)};
    background: transparent;
    text-transform: none;
  }

  .badge.variant {
    border: 1px solid ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}11;
    text-transform: none;
  }

  .badge.warn {
    border: 1px solid ${unsafeCSS(colors.statusWarn)}66;
    color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.statusWarn)}11;
  }

  .badge.family-chip {
    border: 1px solid var(--chip-color, ${unsafeCSS(colors.textMuted)});
    color: ${unsafeCSS(colors.textSecondary)};
    background: color-mix(
      in srgb,
      var(--chip-color, ${unsafeCSS(colors.textMuted)}) 12%,
      transparent
    );
    text-transform: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .badge.family-chip.current {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)}18;
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
  }

  .family-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--chip-color, ${unsafeCSS(colors.textMuted)});
    flex: 0 0 auto;
  }
`;
