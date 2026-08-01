import { css, unsafeCSS } from 'lit';

import { colors, fonts, radii, shadows, spacing } from '../../styles/theme-tokens.js';

export const workGraphPanelStyles = css`
  :host {
    box-sizing: border-box;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    /* Fill the clipped app-shell screen body; do not grow past it or the
       side panel cannot scroll and dispatch config is cut off. */
    height: 100%;
    min-height: 0;
    max-height: 100%;
    overflow: hidden;
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
    flex: 0 0 auto;
  }

  h1 {
    margin: 0;
    font-size: ${unsafeCSS(fonts.sizeXl)};
    font-weight: 800;
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

  .inventory-panel {
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.lg)};
    background: ${unsafeCSS(colors.bgSurface)};
    box-shadow: ${unsafeCSS(shadows.card)};
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: ${unsafeCSS(spacing.lg)};
  }

  .inventory-title {
    margin: 0 0 ${unsafeCSS(spacing.md)};
    font-size: ${unsafeCSS(fonts.sizeMd)};
  }

  .empty,
  .graph {
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.lg)};
    background: ${unsafeCSS(colors.bgSurface)};
    box-shadow: ${unsafeCSS(shadows.card)};
  }

  .empty {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: ${unsafeCSS(spacing.xxl)};
    color: ${unsafeCSS(colors.textMuted)};
    line-height: 1.5;
  }

  .graph {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
    margin-bottom: 0;
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
  .badge.candidate,
  .badge.pending,
  .stat.warn {
    color: ${unsafeCSS(colors.statusWarn)};
    border-color: ${unsafeCSS(colors.statusWarn)}55;
  }

  .badge.failed,
  .badge.needs-attention,
  .badge.blocked,
  .badge.missing-spec,
  .stat.bad {
    color: ${unsafeCSS(colors.statusFail)};
    border-color: ${unsafeCSS(colors.statusFail)}66;
  }

  .graph-body {
    display: grid;
    grid-template-columns: minmax(520px, 1.7fr) minmax(360px, 0.45fr);
    gap: ${unsafeCSS(spacing.lg)};
    min-height: 0;
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

  .diagram-card {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
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
    min-height: 0;
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

  .diagram-node .node-shell {
    fill: #0b1120;
    stroke-width: 1.5;
    filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.28));
    transition:
      fill 120ms ease,
      stroke-width 120ms ease,
      transform 120ms ease;
  }

  .diagram-node.reference-node .node-shell {
    fill: #171123;
    stroke-dasharray: 5 4;
  }

  .diagram-node.dimmed {
    opacity: 0.42;
  }

  .diagram-node .selection-halo {
    fill: none;
    stroke: ${unsafeCSS(colors.accent)};
    stroke-width: 2.5;
    stroke-dasharray: 8 4;
    filter: drop-shadow(0 0 14px ${unsafeCSS(colors.accent)}aa);
    pointer-events: none;
  }

  .selected-label {
    fill: ${unsafeCSS(colors.accent)};
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 0.08em;
    paint-order: stroke;
    stroke: #050816;
    stroke-width: 4px;
    stroke-linejoin: round;
    text-transform: uppercase;
    pointer-events: none;
  }

  .diagram-node.reference-node .diagram-node-meta {
    color: ${unsafeCSS(colors.accent)};
  }

  .diagram-node:hover .node-shell,
  .diagram-node:focus-visible .node-shell {
    fill: #111827;
    stroke-width: 2.5;
  }

  .diagram-node.selected .node-shell {
    fill: #111827;
    stroke: ${unsafeCSS(colors.accent)};
    stroke-width: 4;
    filter: drop-shadow(0 0 16px ${unsafeCSS(colors.accent)}88)
      drop-shadow(0 12px 22px rgba(0, 0, 0, 0.45));
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
  .diagram-node-tags,
  .diagram-node-spec {
    font-size: 10px;
  }

  .diagram-node-meta,
  .diagram-node-tags,
  .diagram-node-spec {
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
    align-self: stretch;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
  }

  .side-content {
    display: grid;
    align-content: start;
    gap: ${unsafeCSS(spacing.md)};
    min-height: 0;
    overflow: auto;
    padding: ${unsafeCSS(spacing.md)};
  }

  .node-card,
  .detail-card {
    box-sizing: border-box;
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

  .node-card-badges {
    display: grid;
    justify-items: end;
    gap: 5px;
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

  .detail-summary {
    border: 1px solid ${unsafeCSS(colors.accent)}44;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    color: ${unsafeCSS(colors.textPrimary)};
    background: ${unsafeCSS(colors.accent)}12;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.5;
  }

  .config-head,
  .config-grid,
  .slot-options {
    display: flex;
    flex-wrap: wrap;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .candidate-slots {
    display: grid;
    gap: 2px;
  }

  .candidate-slots-panel {
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgInput)};
  }

  .candidate-slots-panel summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.sm)};
    cursor: pointer;
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    list-style: none;
  }

  .candidate-slots-panel summary::-webkit-details-marker {
    display: none;
  }

  .candidate-slots-panel summary::before {
    content: 'Show';
    color: ${unsafeCSS(colors.accent)};
    font-weight: 700;
  }

  .candidate-slots-panel[open] summary::before {
    content: 'Hide';
  }

  .candidate-slots-panel summary span {
    color: ${unsafeCSS(colors.textMuted)};
  }

  .candidate-slots-panel .candidate-slots {
    border-top: 1px solid ${unsafeCSS(colors.bgCard)};
    padding: ${unsafeCSS(spacing.sm)};
  }

  .config-editor {
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    border: 1px solid ${unsafeCSS(colors.bgCard)};
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.md)};
    background: ${unsafeCSS(colors.bgSurface)};
  }

  .config-head {
    align-items: start;
    justify-content: space-between;
  }

  .config-edit-button,
  .primary-action,
  .secondary-link,
  .dispatch-config-modal button.secondary {
    justify-self: start;
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.sm)};
    background: transparent;
    color: ${unsafeCSS(colors.textSecondary)};
    padding: 6px 10px;
    font: inherit;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    cursor: pointer;
  }

  .config-edit-button:hover,
  .secondary-link:hover,
  .dispatch-config-modal button.secondary:hover {
    border-color: ${unsafeCSS(colors.accent)}66;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .primary-action {
    border-color: ${unsafeCSS(colors.accent)};
    background: ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.bgBase)};
    font-weight: 800;
    box-shadow: 0 0 0 1px ${unsafeCSS(colors.accent)}33;
  }

  .primary-action:hover {
    filter: brightness(1.08);
  }

  .secondary-link {
    text-decoration: none;
  }

  .dispatch-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .config-error {
    color: ${unsafeCSS(colors.statusFail)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .config-message {
    border: 1px solid ${unsafeCSS(colors.statusOk)}55;
    border-radius: ${unsafeCSS(radii.md)};
    padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    color: ${unsafeCSS(colors.statusOk)};
    background: ${unsafeCSS(colors.statusOk)}12;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.45;
  }

  .config-field,
  .config-check {
    display: grid;
    gap: 5px;
    color: ${unsafeCSS(colors.textSecondary)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .config-check {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
  }

  .config-check span {
    display: grid;
    gap: 3px;
  }

  .config-check small {
    color: ${unsafeCSS(colors.textMuted)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
    line-height: 1.4;
  }

  .config-field input,
  .config-field select {
    min-width: 0;
    background: ${unsafeCSS(colors.bgInput)};
    color: ${unsafeCSS(colors.textPrimary)};
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 6px 8px;
    font: inherit;
  }

  .config-grid .config-field {
    flex: 1 1 110px;
  }

  .slot-picker {
    display: grid;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .slot-picker button {
    justify-self: start;
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.sm)};
    background: transparent;
    color: ${unsafeCSS(colors.textSecondary)};
    padding: 5px 8px;
    font: inherit;
    font-size: ${unsafeCSS(fonts.sizeXs)};
    cursor: pointer;
  }

  .config-edit-button:disabled,
  .primary-action:disabled,
  .slot-picker button:disabled,
  .dispatch-config-modal button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    padding: ${unsafeCSS(spacing.lg)};
    background: rgb(0 0 0 / 0.58);
  }

  .dispatch-config-modal {
    width: min(920px, calc(100vw - 32px));
    max-height: min(760px, calc(100vh - 32px));
    overflow: auto;
    border: 1px solid ${unsafeCSS(colors.accent)}55;
    border-radius: ${unsafeCSS(radii.md)};
    background: ${unsafeCSS(colors.bgCard)};
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.35);
    color: ${unsafeCSS(colors.textPrimary)};
    display: grid;
    gap: ${unsafeCSS(spacing.md)};
    padding: ${unsafeCSS(spacing.lg)};
  }

  .dispatch-config-modal header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${unsafeCSS(spacing.md)};
  }

  .dispatch-config-modal h3,
  .dispatch-config-modal p {
    margin: 0;
  }

  .slot-option {
    display: inline-grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 7px;
    align-items: center;
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.sm)};
    padding: 6px 8px;
    color: ${unsafeCSS(colors.textPrimary)};
    background: ${unsafeCSS(colors.bgInput)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .slot-option small {
    grid-column: 2;
    color: ${unsafeCSS(colors.textMuted)};
  }
`;
