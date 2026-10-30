import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { heldDataIsSaved, type ResourceQueryState } from '@farmslot/protocol/client-cache';

import { nativeReadStatus, type NativeReadStatusContext } from './native-read-status.js';

export interface NativeReadStatusRowContext extends Omit<NativeReadStatusContext, 'now'> {
  historyObservation?: ResourceQueryState<unknown>;
  refresh(): void;
}

export function renderNativeReadStatus(ctx: NativeReadStatusRowContext, now = Date.now()) {
  const saved = ctx.historyObservation
    ? heldDataIsSaved(ctx.historyObservation, ctx.connected, now)
    : ctx.saved;
  const status = nativeReadStatus({ ...ctx, saved, now });
  return html`<div
    class="native-read-status"
    data-testid="native-read-status"
    data-state=${status.state}
    title=${ctx.readError || status.age}
  >
    <div class="native-read-status-text">
      <span
        class="status"
        role="status"
        data-state=${status.state === 'ready' && ctx.sessionState ? ctx.sessionState : status.state}
        >${status.text}</span
      >
      <span
        class="meta"
        data-testid=${saved && ctx.observedAt !== undefined
          ? 'native-history-saved'
          : 'native-history-age'}
        data-observed-at=${ctx.observedAt ?? ''}
        title=${status.age}
        >${status.age}</span
      >
    </div>
    ${status.retry
      ? html`<button data-testid="native-refresh" @click=${ctx.refresh}>Retry</button>`
      : nothing}
  </div>`;
}

/** The display clock updates this row only, never the transcript or tool-output renderer. */
@customElement('native-read-status')
export class NativeReadStatusView extends LitElement {
  @property({ attribute: false }) context: NativeReadStatusRowContext = {
    connected: false,
    selected: false,
    caughtUp: false,
    taskHistory: false,
    refresh() {},
  };
  @state() private now = Date.now();
  private timer?: ReturnType<typeof setInterval>;

  protected createRenderRoot() {
    // Keep the existing status, saved-caption and observed-time hooks in the owning view's DOM.
    return this;
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('context')) this.now = Date.now();
  }

  protected updated() {
    const needed =
      this.isConnected &&
      (this.context.observedAt !== undefined ||
        this.context.unavailableSince !== undefined ||
        (this.context.work !== undefined && this.context.sessionState === 'running'));
    if (needed && !this.timer) this.timer = setInterval(() => (this.now = Date.now()), 1000);
    if (!needed) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.now = Date.now();
  }

  disconnectedCallback() {
    clearInterval(this.timer);
    this.timer = undefined;
    super.disconnectedCallback();
  }

  render() {
    return renderNativeReadStatus(this.context, this.now);
  }
}
