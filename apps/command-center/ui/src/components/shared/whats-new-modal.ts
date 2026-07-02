import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { ReleaseNotesPayload } from '../../build-info.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

@customElement('whats-new-modal')
export class WhatsNewModal extends LitElement {
  @property({ attribute: false }) notes: ReleaseNotesPayload | null = null;
  @property({ type: Boolean }) open = false;

  static styles = css`
    :host {
      display: contents;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 1200;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: ${unsafeCSS(spacing.xl)};
      background: rgba(0, 0, 0, 0.55);
    }
    .panel {
      width: min(520px, 100%);
      max-height: min(70vh, 640px);
      overflow: auto;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.lg)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textPrimary)};
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
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
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    h2 {
      margin: ${unsafeCSS(spacing.sm)} 0 0;
      font-size: 1.2rem;
      font-weight: 600;
    }
    .body {
      padding: ${unsafeCSS(spacing.xl)};
    }
    ul {
      margin: 0;
      padding-left: 1.1rem;
      display: grid;
      gap: ${unsafeCSS(spacing.md)};
    }
    li {
      line-height: 1.45;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: ${unsafeCSS(spacing.md)};
      padding: 0 ${unsafeCSS(spacing.xl)} ${unsafeCSS(spacing.xl)};
    }
    button {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: 6px 12px;
      cursor: pointer;
    }
    button.primary {
      border-color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.bgBase)};
    }
  `;

  private dismiss() {
    this.dispatchEvent(new CustomEvent('dismiss', { bubbles: true, composed: true }));
  }

  render() {
    if (!this.open || !this.notes?.items.length) return nothing;
    const dateSuffix = this.notes.date ? ` · ${this.notes.date}` : '';
    return html`
      <div class="backdrop" @click=${() => this.dismiss()}>
        <section class="panel" @click=${(event: Event) => event.stopPropagation()}>
          <div class="head">
            <div>
              <div class="kicker">What's new</div>
              <h2>Command Center v${this.notes.version}${dateSuffix}</h2>
            </div>
          </div>
          <div class="body">
            <ul>
              ${this.notes.items.map((item) => html`<li>${item}</li>`)}
            </ul>
          </div>
          <div class="actions">
            <button class="primary" @click=${() => this.dismiss()}>Got it</button>
          </div>
        </section>
      </div>
    `;
  }
}
