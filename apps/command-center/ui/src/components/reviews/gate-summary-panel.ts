import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { GateSummary } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { gateSummaryDisplay } from '../../utils/review-gate-display.js';

function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'pass':
    case 'done':
      return colors.statusOk;
    case 'issues':
    case 'pending':
      return colors.statusWarn;
    case 'failed':
    case 'cancelled':
      return colors.statusFail;
    default:
      return colors.statusUnknown;
  }
}

/**
 * Shared "what happened to reach this gate" panel — outcome-first (worker →
 * reviews → cost). Renders identically at the publication gate and the
 * retrospective; both surfaces carry a {@link GateSummary}. Reads only from the
 * GateSummary projection via `gateSummaryDisplay`.
 */
@customElement('gate-summary-panel')
export class GateSummaryPanel extends LitElement {
  @property({ attribute: false }) summary?: GateSummary;

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .gs-panel {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid ${unsafeCSS(colors.textMuted)}55;
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .gs-headline {
      font-size: ${unsafeCSS(fonts.sizeMd)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .gs-meta {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.md)};
    }
    .gs-section-title {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-top: ${unsafeCSS(spacing.xs)};
    }
    .gs-row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      flex-wrap: wrap;
    }
    .gs-badge {
      padding: 0 ${unsafeCSS(spacing.sm)};
      border-radius: ${unsafeCSS(radii.sm)};
      border: 1px solid currentColor;
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .gs-rework {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .gs-dim {
      color: ${unsafeCSS(colors.textMuted)};
    }
    details summary {
      cursor: pointer;
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .gs-token-row {
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      padding: 1px 0;
    }
    .gs-total {
      color: ${unsafeCSS(colors.statusOk)};
      font-weight: 600;
    }
    code {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      word-break: break-all;
    }
  `;

  render() {
    if (!this.summary) return nothing;
    const d = gateSummaryDisplay(this.summary);
    return html`
      <div class="gs-panel">
        <div class="gs-headline">${d.headline}</div>
        <div class="gs-meta">
          <span>Worker: ${d.worker}</span>
          ${d.policyLabel ? html`<span>Gate: ${d.policyLabel}</span>` : nothing}
        </div>

        <div class="gs-section-title">Reviews</div>
        ${d.selfReview
          ? html`<div class="gs-row">
              <span
                class="gs-badge"
                style="color:${verdictColor(d.selfReview.verdict ?? d.selfReview.status)}"
                >Self-review ${d.selfReview.status}</span
              >
              ${d.selfReview.reason
                ? html`<span class="gs-dim">${d.selfReview.reason}</span>`
                : nothing}
            </div>`
          : nothing}
        ${d.reviews.length
          ? d.reviews.map(
              (r) =>
                html`<div class="gs-row">
                  <span class="gs-badge" style="color:${verdictColor(r.verdict)}"
                    >${r.label} ${r.verdict}</span
                  >
                  <span class="gs-dim"
                    >${r.attempts} attempt${r.attempts === 1 ? '' : 's'} · ${r.unresolvedCount}
                    unresolved</span
                  >
                  ${r.triggeredReWork
                    ? html`<span class="gs-rework">sent feedback → triggered re-work</span>`
                    : nothing}
                </div>`,
            )
          : html`<div class="gs-dim">No independent reviews</div>`}
        <div class="gs-row gs-dim">
          <span>${d.passingLabel}</span>
          <span>${d.reWorkCount} review${d.reWorkCount === 1 ? '' : 's'} triggered re-work</span>
          <span>${d.unresolvedTotal} unresolved total</span>
        </div>

        <details>
          <summary>Cost — ${d.tokens.grandTotal} tokens to reach this gate</summary>
          <div class="gs-token-row">
            <span>${d.tokens.mainWorker.label} (${d.tokens.mainWorker.model})</span>
            <span>${d.tokens.mainWorker.total}</span>
          </div>
          ${d.tokens.reviews.map(
            (r) =>
              html`<div class="gs-token-row">
                <span>${r.label} (${r.model})</span><span>${r.total}</span>
              </div>`,
          )}
          ${d.tokens.chainedLoops.map(
            (c) =>
              html`<div class="gs-token-row">
                <span>${c.flowType} ${c.label} (${c.model})</span><span>${c.total}</span>
              </div>`,
          )}
          <div class="gs-token-row gs-total">
            <span>Family grand total</span><span>${d.tokens.grandTotal}</span>
          </div>
          ${d.tokens.sessionPaths.length
            ? html`<div class="gs-section-title">Per-turn sessions</div>
                ${d.tokens.sessionPaths.map((p) => html`<div><code>${p}</code></div>`)}`
            : nothing}
        </details>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gate-summary-panel': GateSummaryPanel;
  }
}
