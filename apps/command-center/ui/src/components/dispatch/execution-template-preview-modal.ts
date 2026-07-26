import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ExecutionTemplateCatalogOption, TemplatePreview } from '@farmslot/protocol';

import { colors, fonts, radii, shadows, spacing } from '../../styles/theme-tokens.js';

import { parseExecutionTemplateOutline } from './execution-template-preview-model.js';

type PreviewView = 'outline' | 'raw';

@customElement('execution-template-preview-modal')
export class ExecutionTemplatePreviewModal extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) option: ExecutionTemplateCatalogOption | null = null;
  @property({ attribute: false }) preview: TemplatePreview | null = null;
  @property({ type: Boolean }) loading = false;
  @property() error = '';
  @state() private _view: PreviewView = 'outline';

  static styles = css`
    :host {
      display: contents;
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 1200;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: ${unsafeCSS(spacing.xl)};
      background: rgba(0, 0, 0, 0.62);
    }

    .panel {
      display: flex;
      width: min(860px, 100%);
      max-height: min(82vh, 820px);
      flex-direction: column;
      overflow: hidden;
      border: 1px solid ${unsafeCSS(colors.accent)}66;
      border-radius: ${unsafeCSS(radii.lg)};
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      box-shadow: ${unsafeCSS(shadows.elevated)};
    }

    .head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.lg)};
      padding: ${unsafeCSS(spacing.xl)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }

    .kicker {
      color: ${unsafeCSS(colors.accent)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h2 {
      margin: ${unsafeCSS(spacing.sm)} 0 0;
      font-size: ${unsafeCSS(fonts.sizeLg)};
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      margin-top: ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .description {
      max-width: 680px;
      margin-top: ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.45;
    }

    .close {
      flex: 0 0 auto;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      font: inherit;
      font-size: 18px;
      line-height: 1;
      padding: 4px 9px;
      cursor: pointer;
    }

    .close:hover,
    .close:focus-visible {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.textPrimary)};
      outline: none;
    }

    .body {
      min-height: 180px;
      overflow: auto;
      padding: ${unsafeCSS(spacing.xl)};
    }

    .view-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.lg)};
      margin-bottom: ${unsafeCSS(spacing.lg)};
    }

    .summary {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .tabs {
      display: flex;
      gap: 4px;
    }

    .tab {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textMuted)};
      font: inherit;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 5px 10px;
      cursor: pointer;
    }

    .tab.active,
    .tab:hover,
    .tab:focus-visible {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.textPrimary)};
      outline: none;
    }

    .outline {
      display: grid;
      gap: ${unsafeCSS(spacing.lg)};
    }

    .phase {
      overflow: hidden;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgBase)};
    }

    .phase-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
    }

    .phase-count {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 400;
    }

    .step {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      gap: ${unsafeCSS(spacing.sm)};
      padding: 9px ${unsafeCSS(spacing.lg)};
      border-top: 1px solid ${unsafeCSS(colors.bgCard)}99;
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.4;
    }

    .step:first-child {
      border-top: 0;
    }

    .checkbox {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .step.checked,
    .step.checked .checkbox {
      color: ${unsafeCSS(colors.statusOk)};
    }

    .status,
    .error {
      padding: ${unsafeCSS(spacing.xl)};
      text-align: center;
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }

    .status {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .error {
      color: ${unsafeCSS(colors.statusFail)};
    }

    .retry {
      margin-top: ${unsafeCSS(spacing.lg)};
      border: 1px solid ${unsafeCSS(colors.accent)};
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.accent)}18;
      color: ${unsafeCSS(colors.textPrimary)};
      font: inherit;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      cursor: pointer;
    }

    pre {
      box-sizing: border-box;
      margin: 0;
      padding: ${unsafeCSS(spacing.xl)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgBase)};
      color: ${unsafeCSS(colors.textSecondary)};
      font: ${unsafeCSS(fonts.sizeSm)} / ${1.55} ${unsafeCSS(fonts.mono)};
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeydown);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('keydown', this._onKeydown);
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      this._view = 'outline';
      void this.updateComplete.then(() => {
        this.shadowRoot?.querySelector<HTMLButtonElement>('.close')?.focus();
      });
    }
  }

  private readonly _onKeydown = (event: KeyboardEvent): void => {
    if (this.open && event.key === 'Escape') this._close();
  };

  private _close(): void {
    this.dispatchEvent(new CustomEvent('preview-close', { bubbles: true, composed: true }));
  }

  private _refresh(): void {
    this.dispatchEvent(new CustomEvent('preview-refresh', { bubbles: true, composed: true }));
  }

  private _renderPreview(preview: TemplatePreview) {
    const outline = parseExecutionTemplateOutline(preview.rawMarkdown);
    return html`
      <div class="view-bar">
        <div class="summary">
          ${outline.totalSteps > 0
            ? `${outline.totalSteps} ${outline.totalSteps === 1 ? 'step' : 'steps'} · ${
                outline.phases.length
              } ${outline.phases.length === 1 ? 'phase' : 'phases'}${
                outline.checkedSteps > 0 ? ` · ${outline.checkedSteps} pre-checked` : ''
              }`
            : 'No checklist steps detected'}
        </div>
        <div class="tabs" role="tablist" aria-label="Template preview format">
          <button
            class="tab ${this._view === 'outline' ? 'active' : ''}"
            role="tab"
            aria-selected=${this._view === 'outline'}
            @click=${() => (this._view = 'outline')}
          >
            Outline
          </button>
          <button
            class="tab ${this._view === 'raw' ? 'active' : ''}"
            role="tab"
            aria-selected=${this._view === 'raw'}
            @click=${() => (this._view = 'raw')}
          >
            Raw
          </button>
        </div>
      </div>
      ${this._view === 'raw'
        ? html`<pre>${preview.rawMarkdown}</pre>`
        : outline.totalSteps === 0
          ? html`<div class="status">
              This template has no checkbox steps. Use Raw to inspect it.
            </div>`
          : html`
              <div class="outline">
                ${outline.phases.map(
                  (phase) => html`
                    <section class="phase">
                      <div class="phase-head">
                        <span>${phase.title}</span>
                        <span class="phase-count"
                          >${phase.steps.length}
                          ${phase.steps.length === 1 ? 'step' : 'steps'}</span
                        >
                      </div>
                      <div>
                        ${phase.steps.map(
                          (step) => html`
                            <div class="step ${step.checked ? 'checked' : ''}">
                              <span class="checkbox" aria-hidden="true"
                                >${step.checked ? '☑' : '☐'}</span
                              >
                              <span>${step.text}</span>
                            </div>
                          `,
                        )}
                      </div>
                    </section>
                  `,
                )}
              </div>
            `}
    `;
  }

  override render() {
    if (!this.open || !this.option) return nothing;
    return html`
      <div
        class="backdrop"
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) this._close();
        }}
      >
        <section
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="execution-template-preview-title"
        >
          <div class="head">
            <div>
              <div class="kicker">Execution template</div>
              <h2 id="execution-template-preview-title">${this.option.title}</h2>
              ${this.option.description
                ? html`<div class="description">${this.option.description}</div>`
                : nothing}
              <div class="meta">
                <span>source ${this.option.sourceId} (${this.option.sourceKind})</span>
                <span>path ${this.option.relativePath}</span>
                ${this.option.sourceRevision
                  ? html`<span>revision ${this.option.sourceRevision}</span>`
                  : nothing}
                ${this.option.sourceDirty ? html`<span>uncommitted source</span>` : nothing}
                <span>digest ${this.option.sha256.slice(0, 12)}</span>
              </div>
            </div>
            <button class="close" aria-label="Close template preview" @click=${() => this._close()}>
              ×
            </button>
          </div>
          <div class="body" tabindex="0" aria-label="Execution template source">
            ${this.loading
              ? html`<div class="status">Loading exact template…</div>`
              : this.error
                ? html`<div class="error">
                    <div>${this.error}</div>
                    <button class="retry" @click=${() => this._refresh()}>Refresh templates</button>
                  </div>`
                : this.preview
                  ? this._renderPreview(this.preview)
                  : html`<div class="status">No preview available.</div>`}
          </div>
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'execution-template-preview-modal': ExecutionTemplatePreviewModal;
  }
}
