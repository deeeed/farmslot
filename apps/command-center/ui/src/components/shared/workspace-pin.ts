import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts } from '../../styles/theme-tokens.js';
import {
  isWorkspacePinned,
  PINNED_SLOTS_CHANGED,
  togglePinnedWorkspace,
} from '../../utils/pinned-slots.js';

/** The same pin control for slots, worktree runs and their terminal headers. */
@customElement('workspace-pin')
export class WorkspacePin extends LitElement {
  @property() slotId = '';
  @property() runId = '';
  @property() label = '';
  private readonly changed = () => this.requestUpdate();

  static styles = css`
    :host {
      display: inline-flex;
      vertical-align: middle;
    }
    button {
      color: ${unsafeCSS(colors.textMuted)};
      background: transparent;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      padding: 2px 6px;
      cursor: pointer;
      font: 11px ${unsafeCSS(fonts.mono)};
    }
    button[aria-pressed='true'] {
      color: ${unsafeCSS(colors.accent)};
      border-color: currentColor;
    }
  `;
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(PINNED_SLOTS_CHANGED, this.changed);
  }
  disconnectedCallback() {
    window.removeEventListener(PINNED_SLOTS_CHANGED, this.changed);
    super.disconnectedCallback();
  }
  render() {
    if (!this.slotId && !this.runId) return nothing;
    const target = this.slotId ? { slotId: this.slotId } : { runId: this.runId };
    const pinned = isWorkspacePinned(target);
    return html`<button
      type="button"
      aria-pressed=${pinned}
      title=${pinned ? 'Unpin workspace' : 'Pin workspace'}
      @click=${(event: Event) => {
        event.stopPropagation();
        togglePinnedWorkspace(target, this.label || undefined);
        this.dispatchEvent(new CustomEvent('pin-changed', { bubbles: true, composed: true }));
      }}
    >
      ${pinned ? 'Pinned' : '+ Pin'}
    </button>`;
  }
}
