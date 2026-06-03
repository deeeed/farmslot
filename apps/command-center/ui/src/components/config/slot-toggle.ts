import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { PoolSlotMode } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

@customElement('slot-toggle')
export class SlotToggle extends LitElement {
  @property() slotId = '';
  @property({ type: Boolean }) enabled = true;
  @property() mode: PoolSlotMode = 'dispatch';
  @property() lifecycle = '';

  @state() private _busy = false;

  private get _locked(): boolean {
    return this.lifecycle === 'busy';
  }

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
    }

    .toggle {
      position: relative;
      width: 32px;
      height: 18px;
      border-radius: 9px;
      border: none;
      cursor: pointer;
      transition: background 0.2s;
      padding: 0;
    }

    .toggle.on {
      background: ${unsafeCSS(colors.statusOk)}55;
    }

    .toggle.off {
      background: ${unsafeCSS(colors.bgCard)};
    }

    .toggle.locked {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .toggle.busy {
      opacity: 0.6;
      cursor: wait;
    }

    .toggle-knob {
      position: absolute;
      top: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      transition:
        left 0.2s,
        background 0.2s;
    }

    .toggle.on .toggle-knob {
      left: 16px;
      background: ${unsafeCSS(colors.statusOk)};
    }

    .toggle.off .toggle-knob {
      left: 2px;
      background: ${unsafeCSS(colors.textMuted)};
    }

    .label {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
    }
  `;

  private async handleToggle() {
    if (this._locked || this._busy) return;
    this._busy = true;
    try {
      const newEnabled = !this.enabled;
      await gateway.request(Methods.CONFIG_SLOT_UPDATE, {
        slotId: this.slotId,
        update: {
          enabled: newEnabled,
          mode: newEnabled ? 'dispatch' : 'disabled',
        },
      });
      this.dispatchEvent(
        new CustomEvent('slot-toggled', {
          detail: { slotId: this.slotId, enabled: newEnabled },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      console.error(`[slot-toggle] failed to update ${this.slotId}:`, (err as Error).message);
    } finally {
      this._busy = false;
    }
  }

  render() {
    const on = this.enabled && this.mode !== 'disabled';
    const cls = `toggle ${on ? 'on' : 'off'} ${this._locked ? 'locked' : ''} ${this._busy ? 'busy' : ''}`;
    return html`
      <button
        class=${cls}
        title=${this._locked
          ? `Cannot toggle: slot is ${this.lifecycle}`
          : on
            ? 'Disable slot'
            : 'Enable slot'}
        @click=${this.handleToggle}
      >
        <div class="toggle-knob"></div>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-toggle': SlotToggle;
  }
}
