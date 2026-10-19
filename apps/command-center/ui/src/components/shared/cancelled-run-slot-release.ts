import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  type CancelledRunSlotHold,
  releaseCancelledRunSlot,
  type SlotReleaseResult,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts } from '../../styles/theme-tokens.js';
import { SLOT_OPERATION_TIMEOUT_MS } from '../../utils/resource-operation-timeout.js';

import { ConfirmActionTimer } from './confirm-action-model.js';

/** The run view's other choice, shown before the release. */
export interface CancelledRunSlotReplay {
  label: string;
  disabled: boolean;
  onReplay: () => void;
}

/** A slot a cancelled run keeps for replay, with its release (ADR-054, 2026-10-19). */
@customElement('cancelled-run-slot-release')
export class CancelledRunSlotRelease extends LitElement {
  @property({ attribute: false }) hold: CancelledRunSlotHold | null = null;
  @property({ attribute: false }) replay: CancelledRunSlotReplay | null = null;
  @state() private _pendingConfirm: string | null = null;
  @state() private _releasing = false;
  @state() private _error = '';
  private readonly _confirm = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });

  static styles = css`
    :host {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      font: 11px ${unsafeCSS(fonts.mono)};
    }
    .held {
      color: ${unsafeCSS(colors.lifecycleHeld)};
    }
    button {
      color: ${unsafeCSS(colors.textPrimary)};
      background: transparent;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      padding: 2px 6px;
      cursor: pointer;
      font: inherit;
    }
    button:disabled {
      cursor: default;
      opacity: 0.5;
    }
    .error {
      color: ${unsafeCSS(colors.statusFail)};
    }
  `;

  disconnectedCallback() {
    this._confirm.clear();
    super.disconnectedCallback();
  }

  render() {
    const { hold, replay } = this;
    if (!hold) return nothing;
    return html`<span
        class="held"
        data-testid="cancelled-run-slot-held"
        title=${`${hold.slotId} is kept for replay by cancelled run ${hold.runId}`}
        >${hold.label}</span
      >
      ${replay
        ? html`<button
            type="button"
            data-testid="cancelled-run-slot-replay"
            ?disabled=${replay.disabled || this._releasing}
            @click=${(event: Event) => this._choose(event, 'replay', replay.onReplay)}
          >
            ${this._pendingConfirm === 'replay' ? 'Confirm replay?' : replay.label}
          </button>`
        : nothing}
      <button
        type="button"
        data-testid="cancelled-run-slot-release"
        title=${hold.releaseConfirm}
        ?disabled=${this._releasing}
        @click=${(event: Event) => this._choose(event, 'release', () => void this._release(hold))}
      >
        ${this._releasing
          ? 'Releasing…'
          : this._pendingConfirm === 'release'
            ? 'Confirm release?'
            : hold.releaseLabel}
      </button>
      ${this._error ? html`<span class="error" role="alert">${this._error}</span>` : nothing}`;
  }

  private _choose(event: Event, actionId: string, execute: () => void) {
    event.stopPropagation();
    this._confirm.confirm(actionId, execute);
  }

  private async _release(hold: CancelledRunSlotHold) {
    this._releasing = true;
    this._error = '';
    try {
      const refusal = await releaseCancelledRunSlot(
        (method, params) =>
          gateway.request<SlotReleaseResult>(method, params, SLOT_OPERATION_TIMEOUT_MS),
        hold,
      );
      this._error = refusal ?? '';
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._releasing = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cancelled-run-slot-release': CancelledRunSlotRelease;
  }
}
