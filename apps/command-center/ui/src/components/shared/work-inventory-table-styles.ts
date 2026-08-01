import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

/**
 * Shared visual tokens for work inventory tables.
 * Surfaces provide their own `grid-template-columns` via inline style or a
 * surface-local class that sets `--work-inventory-columns`.
 */
export const workInventoryTableStyles = css`
  .work-inventory-table {
    min-width: 0;
    width: 100%;
  }
  .work-inventory-scroll {
    overflow-x: auto;
  }
  .work-inventory-head,
  .work-inventory-row {
    align-items: center;
    display: grid;
    gap: 8px;
    grid-template-columns: var(--work-inventory-columns, minmax(0, 1fr));
  }
  .work-inventory-head {
    background: ${unsafeCSS(colors.bgCard)};
    border-bottom: 1px solid ${unsafeCSS(colors.textMuted)}33;
    padding: 3px 8px 6px;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .work-inventory-head button {
    background: transparent;
    border: 0;
    color: ${unsafeCSS(colors.textMuted)};
    cursor: pointer;
    font-family: inherit;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    padding: 2px 0;
    text-align: left;
  }
  .work-inventory-head button.active {
    color: ${unsafeCSS(colors.textPrimary)};
  }
  .work-inventory-head .col-label {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .work-inventory-row {
    background: ${unsafeCSS(colors.bgSurface)};
    border: 1px solid transparent;
    border-radius: ${unsafeCSS(radii.sm)};
    cursor: pointer;
    /* Base text size for cells without their own rule (slot/runner/project/etc).
       Without this, those cells inherit browser 16px next to 10.4–12px siblings. */
    font-size: ${unsafeCSS(fonts.sizeXs)};
    min-height: 28px;
    padding: 4px 8px;
  }
  .work-inventory-row:hover {
    background: ${unsafeCSS(colors.bgCard)};
    border-color: ${unsafeCSS(colors.textMuted)}33;
  }
  .work-inventory-row.selected {
    background: ${unsafeCSS(colors.accent)}11;
    border-color: ${unsafeCSS(colors.accent)}77;
  }
  .work-inventory-row:focus-visible {
    outline: 2px solid ${unsafeCSS(colors.accent)};
    outline-offset: 1px;
  }
  .work-inventory-row .title {
    font-size: ${unsafeCSS(fonts.sizeSm)};
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .work-inventory-row .item-ref {
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .work-inventory-row .updated-cell {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    white-space: nowrap;
  }
  .work-inventory-empty {
    color: ${unsafeCSS(colors.textMuted)};
    padding: ${unsafeCSS(spacing.md)};
  }
  .work-inventory-back {
    background: transparent;
    border: 1px solid ${unsafeCSS(colors.textMuted)}44;
    border-radius: ${unsafeCSS(radii.sm)};
    color: ${unsafeCSS(colors.textSecondary)};
    cursor: pointer;
    font-family: inherit;
    font-size: ${unsafeCSS(fonts.sizeSm)};
    margin-bottom: ${unsafeCSS(spacing.sm)};
    padding: 4px 10px;
  }
  .work-inventory-back:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.accent)};
  }
  .work-inventory-layout {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    grid-template-columns: minmax(0, 1.5fr) minmax(320px, 1fr);
    min-height: 0;
  }
  .work-inventory-layout.list-only,
  .work-inventory-layout.detail-only {
    grid-template-columns: 1fr;
  }
  /* Keep list/detail slots mounted while hidden so scrollTop and selection
     survive narrow detail ↔ list round-trips (display:none retains scroll). */
  .work-inventory-list-slot,
  .work-inventory-detail-slot {
    min-height: 0;
    min-width: 0;
  }
  .work-inventory-list-slot.is-visually-hidden,
  .work-inventory-detail-slot.is-visually-hidden {
    display: none;
  }
`;
