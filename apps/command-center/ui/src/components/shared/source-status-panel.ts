import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  createSourceCommandClient,
  SOURCE_VIEW_ACTION_LABELS,
  SourceStatusController,
  type SourceStatusViewContext,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { sourceChangeFeed } from '../../source-change-feed.js';
import { colors, fonts } from '../../styles/theme-tokens.js';

@customElement('source-status-panel')
export class SourceStatusPanel extends LitElement {
  @property({ attribute: false }) context: SourceStatusViewContext = {
    target: { scope: 'farm', targetId: 'farm' },
    actions: ['sync', 'pin', 'unpin'],
  };
  private controller = new SourceStatusController(
    createSourceCommandClient(async <T>(method: string, params: unknown): Promise<T> => {
      const epoch = gateway.connectionEpoch;
      const principal = gateway.authenticatedPrincipalId;
      const url = gateway.gatewayUrl;
      const result = await gateway.request<T>(method, params, 120_000);
      if (
        epoch !== gateway.connectionEpoch ||
        principal !== gateway.authenticatedPrincipalId ||
        url !== gateway.gatewayUrl
      )
        throw new Error('Source connection changed before acknowledgement.');
      return result;
    }),
    this.context,
  );
  private unsubscribe?: () => void;
  private connectionUnsubscribe?: () => void;
  private feedUnsubscribe?: () => void;
  private selectionsKey = '';

  static styles = css`
    :host {
      display: block;
      margin: 12px 0;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    section {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 8px;
      padding: 12px;
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header h3 {
      margin: 0;
    }
    header p {
      flex: 1;
      margin: 0;
    }
    article {
      border-top: 1px solid ${unsafeCSS(colors.bgCardHover)};
      padding: 10px 0;
    }
    p {
      overflow-wrap: anywhere;
      margin: 5px 0;
      font-size: 12px;
    }
    .facts {
      font-family: ${unsafeCSS(fonts.mono)};
    }
    input,
    button {
      margin: 4px;
      padding: 6px 10px;
      background: ${unsafeCSS(colors.bgSurface)};
      color: inherit;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 5px;
    }
    .error {
      color: ${unsafeCSS(colors.statusFail)};
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = this.controller.subscribe(() => {
      this.requestUpdate();
      this.dispatchEvent(
        new CustomEvent('source-selection-state', {
          detail: { refusal: this.controller.getSnapshot().selectionRefusal },
          bubbles: true,
          composed: true,
        }),
      );
      const selections = this.controller.getSnapshot().selections;
      const key = JSON.stringify(selections);
      if (key !== this.selectionsKey) {
        this.selectionsKey = key;
        this.dispatchEvent(
          new CustomEvent('source-selections-change', {
            detail: { selections },
            bubbles: true,
            composed: true,
          }),
        );
      }
    });
    this.connectionUnsubscribe = gateway.onConnectionChange(() => this.load(true));
    this.feedUnsubscribe = this.controller.attachFeed(sourceChangeFeed);
    this.load(true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.connectionUnsubscribe?.();
    this.feedUnsubscribe?.();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('context')) this.load();
  }

  private load(force = false): void {
    const changed = this.controller.setContext({
      ...this.context,
      connectionKey: `${gateway.gatewayUrl}|${gateway.authenticatedPrincipalId ?? ''}`,
    });
    if ((changed || force) && gateway.connectionState === 'connected' && gateway.isGlobalAdmin)
      void this.controller.refresh();
  }

  render() {
    if (!gateway.isGlobalAdmin) return nothing;
    const state = this.controller.getSnapshot();
    const view = state.view;
    if (state.hidden) return nothing;
    return html`<section data-testid="sources-panel">
      <header>
        <h3>Sources</h3>
        ${view ? html`<p class="facts" data-testid="sources-line">${view.line}</p>` : nothing}
      </header>
      ${state.unsupported
        ? html`<p data-testid="sources-unsupported">Live updates unavailable on this gateway.</p>`
        : nothing}
      ${state.error
        ? html`<p class="error" role="alert">${state.error}</p>
            <button data-testid="sources-read-retry" @click=${() => this.controller.refresh()}>
              Retry
            </button>`
        : nothing}
      ${state.operationError
        ? html`<p class="error" role="alert" data-testid="sources-operation-error">
            ${state.operationError}
          </p>`
        : nothing}
      ${state.notice ? html`<p>${state.notice}</p>` : nothing}
      ${state.pending
        ? html`<p>${state.pendingLabel}</p>
            <button
              data-testid="sources-retry"
              ?disabled=${!state.canRetry}
              @click=${() => this.controller.retry()}
            >
              Retry this request
            </button>`
        : nothing}
      ${view?.errors.map(
        (error) =>
          html`<p class="error" data-testid="sources-status-error">
            ${error.nodeId ?? error.sourceId ?? error.project}: ${error.reason}
          </p>`,
      )}
      ${view && state.controls
        ? view.rows.map(
            (row) =>
              html`<article data-source-id=${row.declaration.id}>
                <p class="facts">${row.declaration.id}</p>
                ${view.editable
                  ? html`<input
                      aria-label="Pushed branch for ${row.declaration.id}"
                      data-testid="source-${row.declaration.id}-branch"
                      placeholder="Pushed branch"
                      .value=${row.selection?.ref ?? ''}
                      ?disabled=${!state.canEdit}
                      @input=${(event: InputEvent) =>
                        this.controller.select({
                          sourceId: row.declaration.id,
                          selection: 'branch',
                          ref: (event.target as HTMLInputElement).value,
                        })}
                    />`
                  : nothing}
                ${row.selectionErrors.map((error) => html`<p class="error">${error}</p>`)}
                ${view.draft
                  ? html`<button
                        ?disabled=${!state.canEdit}
                        data-testid="source-${row.declaration.id}-main"
                        @click=${() =>
                          this.controller.select({
                            sourceId: row.declaration.id,
                            selection: 'main',
                          })}
                      >
                        Use main</button
                      ><button
                        ?disabled=${!state.canEdit}
                        @click=${() => this.controller.clearSelection(row.declaration.id)}
                      >
                        Inherit scope
                      </button>`
                  : nothing}
                ${view.actions.map(
                  (action) =>
                    html`<button
                      data-testid="source-${row.declaration.id}-${action}"
                      ?disabled=${!state.interactive || (action === 'pin' && !row.canPin)}
                      @click=${() => this.controller.apply(action, row.declaration.id)}
                    >
                      ${SOURCE_VIEW_ACTION_LABELS[action]}
                    </button>`,
                )}
              </article>`,
          )
        : nothing}
      ${view?.rows.length
        ? html`<details data-testid="sources-details">
            <summary>Details</summary>
            ${view.rows.map(
              (row) =>
                html`<article data-source-id=${row.declaration.id}>
                  <p class="facts">${row.summary}</p>
                  ${row.details.map((line) => html`<p class="facts">${line}</p>`)}
                </article>`,
            )}
          </details>`
        : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'source-status-panel': SourceStatusPanel;
  }
}
