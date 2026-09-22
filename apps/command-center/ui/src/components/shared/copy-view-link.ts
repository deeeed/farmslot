import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import '../../desktop-connection.js';

@customElement('copy-view-link')
export class CopyViewLink extends LitElement {
  @state() private feedback = '';
  @state() private busy = false;
  private timer?: ReturnType<typeof setTimeout>;

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  private async copy() {
    if (this.busy) return;
    clearTimeout(this.timer);
    this.busy = true;
    try {
      const copy = window.farmslotDesktop?.copyCurrentLink;
      if (!copy) throw new Error('Update and reopen the desktop app to copy view links.');
      await copy();
      this.feedback = 'Link copied';
      this.timer = setTimeout(() => {
        this.feedback = '';
      }, 2500);
    } catch (error) {
      this.feedback = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button {
      font: inherit;
      font-size: 11px;
      color: inherit;
      background: transparent;
      border: 1px solid #424959;
      border-radius: 5px;
      padding: 4px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      background: #292933;
      color: white;
    }
    button:focus-visible {
      outline: 2px solid #8baeff;
      outline-offset: 2px;
    }
    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    span {
      font-size: 11px;
      max-width: 280px;
    }
  `;

  render() {
    return html`<button
        class="copy-link"
        type="button"
        title="Copy a link to open this view in Farmslot"
        ?disabled=${this.busy}
        @click=${() => void this.copy()}
      >
        Copy link
      </button>
      <span role="status" aria-live="polite">${this.feedback}</span>`;
  }
}
