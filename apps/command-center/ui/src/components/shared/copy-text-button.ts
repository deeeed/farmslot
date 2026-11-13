import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { nativeMessageCopyLabel } from '@farmslot/protocol/client-cache';

import { copyTextToClipboard } from '../../utils/clipboard.js';

interface CopyResult {
  text: string;
  copied: boolean;
  error?: string;
}

/**
 * Copies `text` exactly. The label reports the last copy of this same text; a message whose
 * text changed (a streamed reply) starts over. Rendered in the light DOM, so the host's button
 * styles apply.
 */
@customElement('copy-text-button')
export class CopyTextButton extends LitElement {
  @property({ attribute: false }) text = '';
  /** The label before a copy: what gets copied. */
  @property() action = 'Copy';
  @state() private result?: CopyResult;

  protected override createRenderRoot() {
    return this;
  }

  copy(): Promise<void> {
    const text = this.text;
    return copyTextToClipboard(text).then(
      () => void (this.result = { text, copied: true }),
      (error: Error) => void (this.result = { text, copied: false, error: error.message }),
    );
  }

  render() {
    const result = this.result?.text === this.text ? this.result : undefined;
    return html`<button
      type="button"
      class="copy-text"
      data-testid="copy-text"
      title=${result?.error ?? 'Copy this message'}
      @click=${() => void this.copy()}
    >
      ${nativeMessageCopyLabel(result?.copied, this.action)}
    </button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'copy-text-button': CopyTextButton;
  }
}
