import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  FamilyLearningEntry,
  FamilyObservabilityArtifact,
  RunStepStatus,
} from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { formatBytes } from '../../utils/format.js';

/**
 * Shared expandable step row used by family-observability and step-inspector.
 *
 * Pure presentational — host wires the artifact click to a `media-lightbox`
 * via the `step-artifact-click` custom event. Empty / no-artifact steps still
 * expand to show the empty state so the affordance stays uniform.
 */
@customElement('step-artifacts')
export class StepArtifacts extends LitElement {
  @property() stepName = '';
  @property() status: RunStepStatus = 'pending';
  @property({ type: Number }) durationMs?: number;
  @property() detail?: string;
  @property({ attribute: false }) artifacts: FamilyObservabilityArtifact[] = [];
  @property({ attribute: false }) learnings: FamilyLearningEntry[] = [];
  @property({ attribute: false }) missingData: string[] = [];
  @property({ attribute: false }) artifactUrl?: (a: FamilyObservabilityArtifact) => string;
  @property({ type: Boolean, attribute: 'default-open' }) defaultOpen = false;

  static styles = css`
    :host {
      display: block;
    }
    .step-row {
      display: grid;
      grid-template-columns: 12px 1fr auto auto;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid ${unsafeCSS(colors.textMuted)}11;
      align-items: center;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
      cursor: pointer;
    }
    .step-row::-webkit-details-marker {
      display: none;
    }
    .step-row::marker {
      content: '';
    } /* Firefox + spec-compliant */
    .chevron {
      color: ${unsafeCSS(colors.textMuted)};
      transition: transform 0.15s ease;
      display: inline-block;
      font-size: 10px;
    }
    :host(.open) .chevron,
    details[open] > summary .chevron {
      transform: rotate(90deg);
    }
    details[open] > .step-row {
      border-bottom-color: ${unsafeCSS(colors.textMuted)}33;
    }
    .body {
      padding: 8px 0 12px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
    }
    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: ${unsafeCSS(colors.textMuted)};
      margin-bottom: 4px;
    }
    .list {
      margin: 0;
      padding-left: 18px;
      line-height: 1.6;
    }
    .muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .artifact-link {
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
      cursor: pointer;
    }
    .artifact-link:hover {
      text-decoration: underline;
    }
    .status {
      font-family: ${unsafeCSS(fonts.mono)};
    }
  `;

  private _formatDuration(ms?: number): string {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }

  private _statusColor(): string {
    switch (this.status) {
      case 'done':
        return colors.statusOk;
      case 'failed':
        return colors.statusFail;
      case 'running':
        return colors.statusWarn;
      case 'skipped':
        return colors.textMuted;
      default:
        return colors.textMuted;
    }
  }

  private _onArtifactClick(index: number, e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('step-artifact-click', {
        detail: { artifacts: this.artifacts, index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const url = this.artifactUrl;
    const content = html`
      <summary class="step-row">
        <span class="chevron">▸</span>
        <span>${this.stepName}</span>
        <span class="status" style=${`color:${this._statusColor()}`}>${this.status}</span>
        <span>${this._formatDuration(this.durationMs)}</span>
      </summary>
      <div class="body">
        ${this.detail ? html`<div class="muted">${this.detail}</div>` : nothing}
        <div>
          <div class="section-title">
            Artifacts${this.artifacts.length ? html` (${this.artifacts.length})` : nothing}
          </div>
          ${this.artifacts.length
            ? html`
                <ul class="list">
                  ${this.artifacts.map(
                    (a, i) => html`
                      <li>
                        <a
                          class="artifact-link"
                          href=${url ? url(a) : '#'}
                          @click=${(e: Event) => this._onArtifactClick(i, e)}
                          >${a.path}</a
                        >
                        <span class="muted">
                          ·
                          ${a.purpose}${a.sizeBytes != null
                            ? ` · ${formatBytes(a.sizeBytes)}`
                            : ''}</span
                        >
                      </li>
                    `,
                  )}
                </ul>
              `
            : html`<div class="muted">No artifacts captured for this step.</div>`}
        </div>
        ${this.learnings.length
          ? html`
              <div>
                <div class="section-title">Learnings (${this.learnings.length})</div>
                <ul class="list">
                  ${this.learnings.map(
                    (l) =>
                      html`<li>
                        <strong>${l.title}</strong> · <span class="muted">${l.summary}</span>
                      </li>`,
                  )}
                </ul>
              </div>
            `
          : nothing}
        ${this.missingData.length
          ? html`
              <div>
                <div class="section-title">Missing</div>
                <ul class="list">
                  ${this.missingData.map((m) => html`<li>${m}</li>`)}
                </ul>
              </div>
            `
          : nothing}
      </div>
    `;
    // Use a static `open` attribute only for the initial template so user
    // toggles are not reset by later Lit updates.
    return this.defaultOpen
      ? html`<details open>${content}</details>`
      : html`<details>${content}</details>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'step-artifacts': StepArtifacts;
  }
}
