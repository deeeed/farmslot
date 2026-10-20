import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

import type { EvidenceReviewOccurrence } from '@farmslot/adapter-sdk/evidence';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

/** A checked value as the dialog lists it: text as is, anything else as JSON. */
function checkFieldText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A recipe step's Details button and the dialog it opens: what the step
 * checked (result, intent, action, node, checked values). Hosts may drive
 * `open` (a link can reopen it); it reports every change.
 */
@customElement('proof-step-details')
export class ProofStepDetails extends LitElement {
  @property({ attribute: false }) step: EvidenceReviewOccurrence | null = null;
  /** The dialog title, for example the criterion and the step's time. */
  @property() heading = '';
  @property({ type: Boolean }) open = false;
  @query('dialog') private dialog?: HTMLDialogElement;

  static styles = css`
    :host {
      display: contents;
    }
    .open {
      align-self: center;
      padding: 2px 8px;
      font: inherit;
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
      background: transparent;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      cursor: pointer;
    }
    .open:hover {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    @media (pointer: coarse) {
      .open,
      .close {
        min-height: 44px;
        min-width: 44px;
      }
    }
    dialog {
      width: min(640px, calc(100vw - 32px));
      max-height: min(80vh, 720px);
      padding: 0;
      color: ${unsafeCSS(colors.textPrimary)};
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 6px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.55);
    }
    header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }
    h2 {
      flex: 1;
      margin: 0;
      font-size: 13px;
    }
    .close {
      min-height: 36px;
      padding: 4px 12px;
      font: inherit;
      color: ${unsafeCSS(colors.textPrimary)};
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      cursor: pointer;
    }
    dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      margin: 0;
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.lg)};
    }
    dl dl {
      padding: 0;
    }
    dt {
      color: ${unsafeCSS(colors.textMuted)};
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .ok {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .fail {
      color: ${unsafeCSS(colors.statusFail)};
    }
  `;

  protected updated(): void {
    const dialog = this.dialog;
    if (!dialog) return;
    if (this.open && !dialog.open) dialog.showModal();
    else if (!this.open && dialog.open) dialog.close();
  }

  private setOpen(open: boolean) {
    if (this.open === open) return;
    this.open = open;
    this.dispatchEvent(
      new CustomEvent('proof-step-details-toggle', { detail: { open }, bubbles: true }),
    );
  }

  render() {
    const step = this.step;
    if (!step) return nothing;
    return html`<button
        class="open"
        type="button"
        title="What this step checked"
        aria-haspopup="dialog"
        @click=${() => this.setOpen(true)}
      >
        Details
      </button>
      <dialog
        aria-label=${this.heading || 'Step check'}
        @close=${() => this.setOpen(false)}
        @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
      >
        ${this.open
          ? html`<header>
                <h2>${this.heading || 'Step check'}</h2>
                <button class="close" type="button" @click=${() => this.setOpen(false)}>
                  Close
                </button>
              </header>
              <dl>
                <dt>Result</dt>
                <dd class=${step.ok ? 'ok' : 'fail'}>${step.ok ? 'pass' : 'fail'}</dd>
                <dt>Intent</dt>
                <dd>${step.intent}</dd>
                <dt>Action</dt>
                <dd><code>${step.action}</code></dd>
                <dt>Node</dt>
                <dd><code>${step.nodeId}</code></dd>
                ${Object.entries(step.expectation ?? {}).map(
                  ([key, value]) =>
                    html`<dt>${key}</dt>
                      <dd>
                        ${value && typeof value === 'object' && !Array.isArray(value)
                          ? html`<dl>
                              ${Object.entries(value).map(
                                ([field, fieldValue]) =>
                                  html`<dt>${field}</dt>
                                    <dd><code>${checkFieldText(fieldValue)}</code></dd>`,
                              )}
                            </dl>`
                          : html`<code>${checkFieldText(value)}</code>`}
                      </dd>`,
                )}
              </dl>`
          : nothing}
      </dialog>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'proof-step-details': ProofStepDetails;
  }
}
