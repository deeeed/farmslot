import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { Methods } from '@farmslot/protocol';
import { FleetRefreshViewModel } from '@farmslot/review-dispatch';

import { gateway } from '../../gateway-client.js';
import { getResourceCache, getResourceWorkspaceKey } from '../../resource-cache.js';
import { fleetQuery, getState, requireCurrentFleet } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';

/** Inspection rereads the shared fleet observation; release and cancel stay explicit commands. */
async function fleetRefreshRequest<T>(
  method: string,
  params?: unknown,
  timeout?: number,
): Promise<T> {
  if (method === Methods.FLEET_STATUS) {
    const cache = getResourceCache();
    const owner = getResourceWorkspaceKey();
    if (!cache) throw new Error('Offline fleet store is unavailable');
    const state = await cache.retry(fleetQuery);
    if (cache !== getResourceCache() || owner !== getResourceWorkspaceKey())
      throw new Error('Farm connection changed; inspect again');
    if (state.status !== 'ready' || !state.data)
      throw new Error(state.error?.message ?? 'Wait for a current fleet read before acting.');
    return state.data as T;
  }
  if (method === Methods.FLEET_REFRESH_SLOTS_CANCEL)
    return gateway.request<T>(Methods.FLEET_REFRESH_SLOTS_CANCEL, params, timeout);
  requireCurrentFleet();
  if (method === Methods.SLOT_REFRESH)
    return gateway.request<T>(Methods.SLOT_REFRESH, params, timeout);
  if (method === Methods.FLEET_REFRESH_SLOTS)
    return gateway.request<T>(Methods.FLEET_REFRESH_SLOTS, params, timeout);
  throw new Error(`Fleet release does not send ${method}`);
}

@customElement('fleet-refresh-modal')
export class FleetRefreshModal extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) slotIds: string[] = [];
  @property({ attribute: false }) singleSlotId = '';
  @property({ type: Boolean }) inspectOnly = false;
  @state() private model: FleetRefreshViewModel | null = null;
  private unsubscribe?: () => void;
  static override styles = css`
    :host {
      font: 13px system-ui;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .backdrop {
      position: fixed;
      inset: 0;
      background: #000a;
      z-index: 120;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .dialog {
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 12px;
      width: min(700px, 100%);
      max-height: 85vh;
      overflow: auto;
      padding: 20px;
    }
    header,
    footer {
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
    }
    h2 {
      font-size: 18px;
      margin: 0;
    }
    article {
      padding: 16px 0;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    .meta,
    .detail {
      color: ${unsafeCSS(colors.textSecondary)};
      margin: 6px 0;
      overflow-wrap: anywhere;
    }
    button {
      min-height: 44px;
      padding: 8px 14px;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      background: ${unsafeCSS(colors.bgCard)};
      color: inherit;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .warning {
      color: ${unsafeCSS(colors.statusWarn)};
      margin: 10px 0;
    }
    .confirm {
      border: 1px solid ${unsafeCSS(colors.statusWarn)};
      padding: 12px;
      border-radius: 8px;
    }
    pre {
      white-space: pre-wrap;
      max-height: 180px;
      overflow: auto;
      font-size: 11px;
    }
    footer {
      padding-top: 16px;
      flex-wrap: wrap;
    }
  `;
  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open')) {
      if (this.open) void this.load();
      else this.teardown();
    }
  }
  private onKeydown = (event: KeyboardEvent) => {
    if (this.open && event.key === 'Escape') this.close();
  };
  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.onKeydown);
  }
  override disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onKeydown);
    this.teardown();
    super.disconnectedCallback();
  }
  private teardown(): void {
    this.unsubscribe?.();
    this.model?.dispose();
    this.model = null;
  }
  private async load(): Promise<void> {
    this.teardown();
    const model = new FleetRefreshViewModel(
      {
        contextKey: () =>
          JSON.stringify([
            gateway.gatewayUrl,
            gateway.credentialGeneration,
            gateway.authenticatedPrincipalId,
          ]),
        request: fleetRefreshRequest,
        subscribe: (event, callback) => gateway.subscribe(event, callback),
      },
      () => `fleet-refresh-${crypto.randomUUID()}`,
    );
    this.model = model;
    this.unsubscribe = model.subscribe(() => this.requestUpdate());
    await model.load(
      this.singleSlotId ? [this.singleSlotId] : [...this.slotIds],
      getState().fleet?.slots,
    );
    if (this.model === model && this.singleSlotId && !this.inspectOnly)
      await model.release(this.singleSlotId);
  }
  private close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }
  override render() {
    if (!this.open || !this.model) return nothing;
    const model = this.model;
    const running = model.phase === 'running';
    return html`<div class="backdrop" @click=${() => this.close()}>
      <section
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Release and update to main"
        @click=${(event: Event) => event.stopPropagation()}
      >
        <header>
          <h2>Release and update to main</h2>
          <button aria-label="Close" @click=${() => this.close()}>Close</button>
        </header>
        ${model.error ? html`<p role="alert" class="warning">${model.error}</p>` : nothing}
        ${model.inspecting ? html`<p role="status">Checking current workspaces…</p>` : nothing}
        ${model.confirmation
          ? html`<div class="confirm" role="alertdialog" aria-label="Discard local work">
              <p>${model.confirmation.warning}</p>
              <button @click=${() => model.cancelConfirmation()}>Keep work</button>
              <button @click=${() => void model.confirmDiscard()}>
                Discard local work and update
              </button>
            </div>`
          : nothing}
        ${model.rows.map(
          (row) =>
            html`<article data-slot=${row.slotId}>
              <strong>${row.slotId}</strong>
              <div class="meta">${row.branch} · ${row.publication} · ${row.owner}</div>
              <div class="meta" title=${row.referenceTime}>
                ${row.behind} · ${row.referenceTime}
              </div>
              ${row.warning ? html`<div class="warning">${row.warning}</div>` : nothing}
              ${row.status !== 'idle'
                ? html`<div class="detail" role="status">${row.status} ${row.detail}</div>`
                : nothing}
              <button
                ?disabled=${!model.canRelease ||
                running ||
                row.status === 'refreshed' ||
                (!row.eligibility.allowed && row.eligibility.reason !== 'unknown')}
                @click=${() => void model.release(row.slotId)}
              >
                ${row.action}
              </button>
              ${row.log.length
                ? html`<details>
                    <summary>Progress</summary>
                    <pre>${row.log.join('\n')}</pre>
                  </details>`
                : nothing}
            </article>`,
        )}
        <footer>
          ${!this.singleSlotId
            ? html`<button
                ?disabled=${!model.canRelease || running || !model.bulkCount}
                @click=${() => void model.releaseIdle()}
              >
                Release idle slots (${model.bulkCount})
              </button>`
            : nothing}
          ${model.canCancel
            ? html`<button @click=${() => void model.cancel()}>Cancel remaining</button>`
            : running
              ? html`<span role="status">Updating...</span>`
              : html`<button @click=${() => void model.load(model.rows.map((row) => row.slotId))}>
                  Inspect again
                </button>`}
          ${model.summary
            ? html`<span role="status"
                >${model.summary.refreshed} ready · ${model.summary.failed} failed ·
                ${model.summary.skipped} skipped</span
              >`
            : nothing}
        </footer>
      </section>
    </div>`;
  }
}
