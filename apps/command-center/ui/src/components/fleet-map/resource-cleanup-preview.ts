import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { ResourcePressureSnapshotResult } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

import {
  pressureBytes,
  pressureProcessCpu,
  pressureProcessName,
} from './machine-pressure-model.js';

@customElement('resource-cleanup-preview')
export class ResourceCleanupPreview extends LitElement {
  @property({ attribute: false }) snapshot?: ResourcePressureSnapshotResult;
  @property({ type: Boolean }) busy = false;

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: grid;
      place-items: center;
      padding: ${unsafeCSS(spacing.xl)};
      background: rgba(0, 0, 0, 0.72);
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .dialog {
      width: min(920px, 100%);
      max-height: min(760px, 90vh);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid ${unsafeCSS(colors.statusWarn)}88;
      border-radius: 10px;
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textSecondary)};
      box-shadow: 0 18px 70px rgba(0, 0, 0, 0.7);
    }
    header,
    footer {
      padding: ${unsafeCSS(spacing.lg)};
      border-color: ${unsafeCSS(colors.bgCard)};
    }
    header {
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    header h2 {
      margin: 0 0 ${unsafeCSS(spacing.sm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeLg)};
    }
    header p,
    .exclusion-note {
      margin: 0;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.5;
    }
    .exclusion-note {
      margin-top: ${unsafeCSS(spacing.sm)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-left: 2px solid ${unsafeCSS(colors.statusOk)};
      background: ${unsafeCSS(colors.statusOk)}0d;
    }
    .targets {
      overflow: auto;
      display: grid;
      gap: ${unsafeCSS(spacing.sm)};
      padding: ${unsafeCSS(spacing.lg)};
    }
    .target {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.4fr);
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      background: ${unsafeCSS(colors.bgInput)};
    }
    .target strong {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .meta,
    .impact {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.55;
    }
    .status {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .impact-known {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .impact-unknown {
      color: ${unsafeCSS(colors.textMuted)};
    }
    footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    .summary {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
    }
    .actions {
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
    }
    button {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 4px;
      padding: 6px 12px;
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      cursor: pointer;
    }
    button.danger {
      color: ${unsafeCSS(colors.statusFail)};
      border-color: ${unsafeCSS(colors.statusFail)}88;
    }
    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .empty {
      padding: ${unsafeCSS(spacing.xxl)};
      text-align: center;
      color: ${unsafeCSS(colors.statusOk)};
    }
    @media (max-width: 700px) {
      .target {
        grid-template-columns: 1fr;
      }
      footer {
        align-items: stretch;
        flex-direction: column;
      }
      .actions {
        justify-content: flex-end;
      }
    }
  `;

  render() {
    const candidates = this.snapshot?.cleanupCandidates ?? [];
    const machines = new Set(candidates.map((candidate) => candidate.machine)).size;
    return html`<section
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Cleanup impact preview"
    >
      <header>
        <h2>Review idle resource cleanup</h2>
        <p>
          This preview is read-only. Execution uses each project’s configured shutdown hook;
          Farmslot does not kill attributed processes directly.
        </p>
        <div class="exclusion-note">
          Active, held, manual, disabled, working, and current-run slots are excluded. Manual and
          system/unmapped process groups are never cleanup targets.
        </div>
      </header>
      ${candidates.length === 0
        ? html`<div class="empty">No idle running or stale resources are eligible.</div>`
        : html`<div class="targets">
            ${candidates.map((candidate) => {
              const impact = candidate.processImpact;
              return html`<article class="target">
                <div class="meta">
                  <strong>${candidate.label}</strong>
                  <div>${candidate.slotId} · ${candidate.machine}</div>
                  <div>${candidate.project} · ${candidate.resourceId}</div>
                  <div class="status">${candidate.status} · ${candidate.slotLifecycle}</div>
                  <div>Effect: configured shutdown hook</div>
                </div>
                <div class="impact ${impact ? 'impact-known' : 'impact-unknown'}">
                  ${impact
                    ? html`<strong>${pressureProcessName(impact.process)}</strong>
                        <div>
                          ${pressureProcessCpu(impact.treeCpuPercent)} tree CPU ·
                          ${pressureBytes(impact.hotRssBytes)} hot RSS · ${impact.processCount}
                          sampled process${impact.processCount === 1 ? '' : 'es'}
                        </div>
                        <div>
                          ${impact.classification} ownership · ${impact.confidence} confidence
                        </div>`
                    : html`Process impact is unavailable in the bounded census. The project shutdown
                      hook determines the exact processes it stops.`}
                </div>
              </article>`;
            })}
          </div>`}
      <footer>
        <span class="summary"
          >${candidates.length} resource${candidates.length === 1 ? '' : 's'} on ${machines}
          machine${machines === 1 ? '' : 's'}</span
        >
        <div class="actions">
          <button ?disabled=${this.busy} @click=${() => this.emit('cleanup-preview-close')}>
            Cancel
          </button>
          <button
            class="danger"
            ?disabled=${this.busy || candidates.length === 0}
            @click=${() => this.emit('cleanup-preview-confirm')}
          >
            ${this.busy
              ? 'Revalidating…'
              : `Stop ${candidates.length} reviewed resource${candidates.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </footer>
    </section>`;
  }

  private emit(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'resource-cleanup-preview': ResourceCleanupPreview;
  }
}
