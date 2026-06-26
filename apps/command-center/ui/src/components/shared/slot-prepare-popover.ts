import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { SlotHealth } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import '../shared/prepare-progress-panel.js';
import type { PrepareProgressState } from './prepare-progress-model.js';
import type { SlotPrepareOptionsChangeDetail } from './slot-prepare-options.js';
import './slot-prepare-options.js';
import { navigateToPreparedSlot, runSlotPrepareForRun } from './slot-prepare-client.js';
import { activeSlotPrepare, subscribeSlotPrepareTracker } from './slot-prepare-tracker.js';

@customElement('slot-prepare-popover')
export class SlotPreparePopover extends LitElement {
  @property({ attribute: 'slot-id' }) slotId = '';
  @property({ attribute: 'slot-branch' }) slotBranch = '';
  @property() project = '';
  @property({ attribute: 'run-id' }) runId = '';
  @property({ attribute: 'run-branch' }) runBranch = '';
  @property() buttonLabel = 'Prepare slot →';
  @property({ type: Boolean }) rebind = false;
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) slotHealth: SlotHealth | null = null;
  @property() buttonClass = 'gate-action-btn';
  @property() buttonStyle = '';

  @state() private _open = false;
  @state() private _busy = false;
  @state() private _error = '';
  @state() private _prepareProfile = 'attach';
  @state() private _strictProfile = true;
  @state() private _forcePrepare = false;
  @state() private _prepareState: PrepareProgressState | null = null;
  private _unsubPrepare?: () => void;

  static override styles = css`
    :host {
      display: inline-block;
      position: relative;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .spp-trigger {
      border: 1px solid ${unsafeCSS(colors.textMuted)};
      color: ${unsafeCSS(colors.textMuted)};
      padding: 4px 12px;
      font-size: 11px;
      border-radius: 3px;
      background: transparent;
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .spp-trigger:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .spp-panel {
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 1200;
      width: min(360px, calc(100vw - 24px));
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgSurface)};
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      padding: ${unsafeCSS(spacing.md)};
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .spp-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: ${unsafeCSS(spacing.xs)};
    }
    .spp-btn {
      border: 1px solid #2a2a44;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      border-radius: ${unsafeCSS(radii.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 11px;
      padding: 4px 9px;
      cursor: pointer;
    }
    .spp-btn.primary {
      border-color: ${unsafeCSS(colors.accent)}44;
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
    }
    .spp-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this._unsubPrepare = subscribeSlotPrepareTracker(() => {
      this._prepareState = this.slotId ? activeSlotPrepare(this.slotId) : null;
    });
    this._outsideClick = this._outsideClick.bind(this);
    document.addEventListener('click', this._outsideClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubPrepare?.();
    document.removeEventListener('click', this._outsideClick);
  }

  private _outsideClick(event: MouseEvent) {
    if (!this._open) return;
    const path = event.composedPath();
    if (!path.includes(this)) this._open = false;
  }

  private _onOptionsChange(event: CustomEvent<SlotPrepareOptionsChangeDetail>) {
    this._prepareProfile = event.detail.prepareProfile;
    this._strictProfile = event.detail.strictProfile;
    this._forcePrepare = event.detail.forcePrepare;
  }

  private async _run(prepareProfile: string, strictProfile: boolean) {
    if (!this.slotId || !this.runId || !this.runBranch || this._busy) return;
    this._prepareProfile = prepareProfile;
    this._strictProfile = strictProfile;
    this._error = '';
    this._busy = true;
    try {
      await runSlotPrepareForRun({
        slotId: this.slotId,
        runId: this.runId,
        branch: this.runBranch,
        slotBranch: this.slotBranch,
        prepareProfile,
        strictProfile,
        forcePrepare: this._forcePrepare,
        rebind: this.rebind,
      });
      this._open = false;
      navigateToPreparedSlot(this.slotId, this.runId);
      this.dispatchEvent(new CustomEvent('completed', { bubbles: true, composed: true }));
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._busy = false;
    }
  }

  private _onRecovery(event: CustomEvent<{ prepareProfile: string; strictProfile: boolean }>) {
    void this._run(event.detail.prepareProfile, event.detail.strictProfile);
  }

  override render() {
    return html`
      <button
        class=${`${this.buttonClass} spp-trigger`}
        style=${this.buttonStyle || undefined}
        ?disabled=${this.disabled || this._busy}
        @click=${(event: Event) => {
          event.stopPropagation();
          this._open = !this._open;
        }}
      >
        ${this._busy ? 'Preparing…' : this.buttonLabel}
      </button>
      ${this._open
        ? html`
            <div class="spp-panel" @click=${(event: Event) => event.stopPropagation()}>
              <slot-prepare-options
                .project=${this.project}
                .prepareProfile=${this._prepareProfile}
                .strictProfile=${this._strictProfile}
                .forcePrepare=${this._forcePrepare}
                .runBranch=${this.runBranch}
                .slotBranch=${this.slotBranch}
                .slotHealth=${this.slotHealth}
                .lastError=${this._error}
                .disabled=${this._busy}
                compact
                @prepare-options-change=${this._onOptionsChange}
                @recovery-retry=${this._onRecovery}
              ></slot-prepare-options>
              ${this._prepareState
                ? html`<prepare-progress-panel
                    .state=${this._prepareState}
                    compact
                  ></prepare-progress-panel>`
                : nothing}
              <div class="spp-actions">
                <button
                  class="spp-btn"
                  ?disabled=${this._busy}
                  @click=${() => (this._open = false)}
                >
                  Cancel
                </button>
                <button
                  class="spp-btn primary"
                  ?disabled=${this._busy}
                  @click=${() => this._run(this._prepareProfile, this._strictProfile)}
                >
                  ${this._busy ? 'Running…' : 'Confirm'}
                </button>
              </div>
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-prepare-popover': SlotPreparePopover;
  }
}
