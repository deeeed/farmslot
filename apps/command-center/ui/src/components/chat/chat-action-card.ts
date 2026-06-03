import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ChatSuggestedAction } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

@customElement('chat-action-card')
export class ChatActionCard extends LitElement {
  @property({ attribute: false }) action!: ChatSuggestedAction;
  @state() private dismissed = false;
  // Per-card pending state keeps siblings interactive while one card is in
  // flight; cleared by the parent's markResolved() after the WS confirm lands.
  @state() private _pending = false;
  @state() private unavailable = false;
  @state() private errorMessage: string | null = null;
  private expiryTimer: number | undefined;

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.scheduleExpiryRefresh();
  }

  override disconnectedCallback() {
    this.clearExpiryTimer();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('action')) this.scheduleExpiryRefresh();
  }

  private onConfirm() {
    if (this._pending || this.unavailable) return;
    if (!this.action.actionId || this.isExpired()) return;
    this._pending = true;
    this.errorMessage = null;
    this.dispatchEvent(
      new CustomEvent('action-confirm', {
        detail: { actionId: this.action.actionId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // Called by chat-panel.onActionConfirm once the WS response lands; success
  // dismisses the card, reject clears _pending and surfaces the error.
  markResolved(result: { ok: boolean; unavailable?: boolean; message?: string }): void {
    this._pending = false;
    if (result.ok) {
      this.dismissed = true;
      return;
    }
    this.errorMessage = result.message ?? 'Action failed.';
    if (result.unavailable) this.unavailable = true;
  }

  private onDismiss() {
    this.dismissed = true;
  }

  private renderParamPreview(): string {
    const p = this.action.params;
    const entries = Object.entries(p).slice(0, 3);
    return entries.map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(', ');
  }

  private isExpired(): boolean {
    if (!this.action.expiresAt) return false;
    const expiresAtMs = Date.parse(this.action.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  }

  private clearExpiryTimer() {
    if (this.expiryTimer === undefined) return;
    window.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private scheduleExpiryRefresh() {
    this.clearExpiryTimer();
    if (!this.action?.expiresAt) return;
    const expiresAtMs = Date.parse(this.action.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return;
    const delayMs = expiresAtMs - Date.now();
    if (delayMs <= 0) return;
    this.expiryTimer = window.setTimeout(() => {
      this.expiryTimer = undefined;
      this.requestUpdate();
    }, delayMs);
  }

  render() {
    if (this.dismissed) return html``;
    const isMemory = this.action.type === 'memory.update';
    const memContent = isMemory ? String(this.action.params.content ?? '') : '';
    const expired = this.isExpired();
    const missingActionId = !this.action.actionId;
    const unavailable = this.unavailable;
    const canConfirm = !missingActionId && !expired && !unavailable && !this._pending;
    const buttonLabel = this._pending
      ? 'Confirming…'
      : missingActionId
        ? 'Unavailable'
        : expired || unavailable
          ? 'Expired'
          : 'Confirm';
    const statusMessage = unavailable
      ? (this.errorMessage ??
        'This action is no longer available. Ask Co-Pilot to propose it again.')
      : expired
        ? 'This action expired. Ask Co-Pilot to propose it again.'
        : missingActionId
          ? 'This legacy action cannot be confirmed. Ask Co-Pilot to propose it again.'
          : this.errorMessage;

    return html`
      <style>
        chat-action-card .cac-root {
          border: 1px solid ${colors.accent}44;
          border-radius: ${radii.md};
          background: ${colors.bgCard};
          padding: ${spacing.md} ${spacing.lg};
          margin-top: ${spacing.md};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeSm};
        }
        chat-action-card .cac-header {
          display: flex;
          align-items: center;
          gap: ${spacing.md};
          margin-bottom: ${spacing.sm};
        }
        chat-action-card .cac-type {
          background: ${colors.accent}33;
          color: ${colors.textAccent};
          border-radius: ${radii.sm};
          padding: 1px 6px;
          font-size: ${fonts.sizeXs};
        }
        chat-action-card .cac-label {
          color: ${colors.textPrimary};
          font-weight: 600;
          flex: 1;
        }
        chat-action-card .cac-preview {
          color: ${colors.textMuted};
          font-size: ${fonts.sizeXs};
          margin-bottom: ${spacing.md};
          word-break: break-word;
        }
        chat-action-card .cac-diff {
          background: ${colors.bgSurface};
          border-radius: ${radii.sm};
          padding: ${spacing.md};
          font-size: ${fonts.sizeXs};
          color: ${colors.textSecondary};
          white-space: pre-wrap;
          max-height: 120px;
          overflow-y: auto;
          margin-bottom: ${spacing.md};
        }
        chat-action-card .cac-actions {
          display: flex;
          gap: ${spacing.md};
        }
        chat-action-card .cac-btn-confirm {
          background: ${colors.accent};
          color: #fff;
          border: none;
          border-radius: ${radii.sm};
          padding: 3px 10px;
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeSm};
          cursor: pointer;
        }
        chat-action-card .cac-btn-confirm:hover {
          background: ${colors.accentHover};
        }
        chat-action-card .cac-btn-confirm:disabled {
          background: ${colors.bgSurface};
          color: ${colors.textMuted};
          cursor: not-allowed;
        }
        chat-action-card .cac-btn-dismiss {
          background: transparent;
          color: ${colors.textMuted};
          border: 1px solid ${colors.textMuted}44;
          border-radius: ${radii.sm};
          padding: 3px 10px;
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeSm};
          cursor: pointer;
        }
        chat-action-card .cac-btn-dismiss:hover {
          color: ${colors.textSecondary};
        }
        chat-action-card .cac-expired {
          color: ${colors.statusWarn};
          font-size: ${fonts.sizeXs};
          margin-bottom: ${spacing.sm};
        }
      </style>
      <div class="cac-root">
        <div class="cac-header">
          <span class="cac-type">${this.action.type}</span>
          <span class="cac-label">${this.action.label}</span>
        </div>
        ${!isMemory
          ? html` <div class="cac-preview">${this.renderParamPreview()}</div> `
          : html`
              <details>
                <summary
                  style="cursor:pointer;color:${colors.textSecondary};font-size:${fonts.sizeXs};margin-bottom:${spacing.sm}"
                >
                  Show memory content
                </summary>
                <div class="cac-diff">${memContent}</div>
              </details>
            `}
        ${statusMessage ? html`<div class="cac-expired">${statusMessage}</div>` : html``}
        <div class="cac-actions">
          <button
            class="cac-btn-confirm"
            @click=${this.onConfirm}
            ?disabled=${!canConfirm}
            aria-busy=${this._pending ? 'true' : 'false'}
          >
            ${buttonLabel}
          </button>
          <button class="cac-btn-dismiss" @click=${this.onDismiss}>Dismiss</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-action-card': ChatActionCard;
  }
}
