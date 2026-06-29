import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, shadows, spacing } from '../../styles/theme-tokens.js';

export const workGraphPanelStyles = css`
  :host {
    display: block;
    padding: ${unsafeCSS(spacing.xxl)};
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.xl)};
    margin-bottom: ${unsafeCSS(spacing.xl)};
  }

  h1 {
    margin: 0;
    font-size: ${unsafeCSS(fonts.sizeXl)};
    font-weight: 800;
    letter-spacing: -0.03em;
  }

  .subtitle {
    margin-top: 6px;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    line-height: 1.5;
  }

  select {
    min-width: 220px;
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textPrimary)};
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: 9px 11px;
    font: inherit;
  }

  .empty,
  .graph {
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.lg)};
    background: ${unsafeCSS(colors.bgSurface)};
    box-shadow: ${unsafeCSS(shadows.card)};
  }

  .empty {
    padding: ${unsafeCSS(spacing.xxl)};
    color: ${unsafeCSS(colors.textMuted)};
    line-height: 1.5;
  }

  .graph {
    margin-bottom: ${unsafeCSS(spacing.xl)};
    overflow: hidden;
  }

  .graph-head {
    display: grid;
    grid-template-columns: minmax(260px, 1fr) auto;
    gap: ${unsafeCSS(spacing.lg)};
    padding: ${unsafeCSS(spacing.xl)};
    border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    background: linear-gradient(135deg, ${unsafeCSS(colors.bgCard)} 0%, #111827 100%);
  }

  .title {
    font-size: ${unsafeCSS(fonts.sizeLg)};
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .meta,
  .small,
  .detail-muted {
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.5;
  }

  .meta {
    margin-top: 4px;
  }

  .badges,
  .legend,
  .refs,
  .stat-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .badges {
    justify-content: flex-end;
    align-content: flex-start;
  }

  .badge,
  .legend-chip,
  .stat {
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: 999px;
    padding: 3px 8px;
    color: ${unsafeCSS(colors.textSecondary)};
    background: ${unsafeCSS(colors.bgInput)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.35;
  }

  .badge.active,
  .badge.done,
  .badge.succeeded,
  .badge.ready,
  .badge.satisfied,
  .stat.good {
    color: ${unsafeCSS(colors.statusOk)};
    border-color: ${unsafeCSS(colors.statusOk)}55;
  }

  .badge.waiting,
  .badge.gated,
  .badge.running,
  .badge.queued,
  .badge.pending,
  .stat.warn {
    color: ${unsafeCSS(colors.statusWarn)};
    border-color: ${unsafeCSS(colors.statusWarn)}55;
  }

  .badge.failed,
  .badge.needs-attention,
  .stat.bad {
    color: ${unsafeCSS(colors.statusFail)};
    border-color: ${unsafeCSS(colors.statusFail)}66;
  }

  .graph-body {
    display: grid;
    grid-template-columns: minmax(520px, 1.7fr) minmax(360px, 0.45fr);
    gap: ${unsafeCSS(spacing.lg)};
    padding: ${unsafeCSS(spacing.lg)};
  }

  @media (max-width: 1100px) {
    :host {
      padding: ${unsafeCSS(spacing.xl)};
    }

    .header,
    .graph-head {
      grid-template-columns: 1fr;
    }

    .header {
      align-items: stretch;
    }

    .badges {
      justify-content: flex-start;
    }

    select,
    .graph-body {
      min-width: 0;
    }

    .graph-body {
      grid-template-columns: 1fr;
    }
  }

  .diagram-card,
  .side-panel {
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.lg)};
    background: #080d18;
    overflow: hidden;
  }

  .diagram-toolbar,
  .side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
    border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    background: #0b1220;
  }

  .diagram-title,
  .side-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: ${unsafeCSS(fonts.sizeSm)};
    font-weight: 800;
  }

  .legend-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 12px currentColor;
  }

  .diagram-scroll {
    min-height: 340px;
    overflow: auto;
    background:
      radial-gradient(circle at 1px 1px, rgba(148, 163, 184, 0.13) 1px, transparent 0) 0 0 / 22px
        22px,
      linear-gradient(180deg, rgba(79, 70, 229, 0.06), rgba(6, 182, 212, 0.03)),
      #050816;
  }

  svg {
    display: block;
    min-width: 100%;
    min-height: 340px;
  }

  .stage-band {
    fill: rgba(148, 163, 184, 0.04);
    stroke: rgba(148, 163, 184, 0.1);
  }

  .stage-label {
    fill: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .edge {
    fill: none;
    stroke-width: 2;
  }

  .edge-label {
    font-size: 9px;
    paint-order: stroke;
    stroke: #050816;
    stroke-width: 3px;
    stroke-linejoin: round;
  }

  .diagram-node {
    cursor: pointer;
    outline: none;
  }

  .diagram-node rect {
    fill: #0b1120;
    stroke-width: 1.5;
    filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.28));
    transition:
      fill 120ms ease,
      stroke-width 120ms ease,
      transform 120ms ease;
  }

  .diagram-node:hover rect,
  .diagram-node:focus-visible rect,
  .diagram-node.selected rect {
    fill: #111827;
    stroke-width: 2.5;
  }

  .diagram-node-content {
    display: grid;
    grid-template-rows: auto auto 1fr;
    gap: 5px;
    height: 100%;
    min-width: 0;
    color: ${unsafeCSS(colors.textPrimary)};
    font-family: ${unsafeCSS(fonts.mono)};
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .diagram-node-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: 12px;
    font-weight: 800;
  }

  .diagram-node-meta,
  .diagram-node-status,
  .diagram-node-tags {
    font-size: 10px;
  }

  .diagram-node-meta,
  .diagram-node-tags {
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .diagram-node-footer {
    align-self: end;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 8px;
  }

  .side-panel {
    align-self: start;
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    padding-bottom: ${unsafeCSS(spacing.md)};
  }

  .side-content {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    padding: 0 ${unsafeCSS(spacing.md)};
  }

  .node-card,
  .detail-card {
    width: 100%;
    color: inherit;
    text-align: left;
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgInput)};
    padding: ${unsafeCSS(spacing.lg)};
    font: inherit;
  }

  .node-card {
    cursor: pointer;
  }

  .node-card:hover,
  .node-card.selected {
    border-color: ${unsafeCSS(colors.accent)}88;
    background: #101827;
  }

  .node-card-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: ${unsafeCSS(spacing.md)};
    align-items: start;
  }

  .node-title,
  .detail-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 800;
    line-height: 1.35;
  }

  .node-title {
    margin-bottom: 5px;
  }

  .detail-card {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    background: #0b1120;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: ${unsafeCSS(spacing.sm)};
  }

  .detail-cell {
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgInput)};
  }

  .detail-label {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .detail-value {
    margin-top: 4px;
    color: ${unsafeCSS(colors.textPrimary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    overflow-wrap: anywhere;
  }

  .waiting-list {
    margin: 4px 0 0;
    padding-left: 18px;
    color: ${unsafeCSS(colors.statusWarn)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.5;
  }

  .ref {
    color: ${unsafeCSS(colors.accent)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    overflow-wrap: anywhere;
  }
`;
