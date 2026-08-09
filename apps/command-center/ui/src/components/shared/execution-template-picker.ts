// Reusable execution-template catalog picker (MANUAL-000076 UX addendum).
// Renders the gateway-provided catalog as a filterable table with the Domain
// and Run-mode filters inside the picker, visible result counts, and per-row
// provenance. Selection/filter changes are emitted as events — the host owns
// state and refetching; the gateway stays the selection/validation authority.
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { ExecutionTemplateCatalogOption, ExecutionTemplateOptions } from '@farmslot/protocol';

import {
  deriveExecutionTemplatePickerView,
  type ExecutionTemplatePickerRow,
} from './execution-template-picker-model.js';

export interface ExecutionTemplatePickerSelectDetail {
  id: string;
}
export interface ExecutionTemplatePickerDomainDetail {
  domain: string;
}
export interface ExecutionTemplatePickerModeDetail {
  mode: 'autonomous' | 'interactive';
}
export interface ExecutionTemplatePickerPreviewDetail {
  option: ExecutionTemplateCatalogOption;
  trigger?: HTMLElement;
}

@customElement('execution-template-picker')
export class ExecutionTemplatePicker extends LitElement {
  @property({ attribute: false }) catalog: ExecutionTemplateOptions | null = null;
  @property() selectedId = '';
  @property() domain = '';
  @property() mode: 'autonomous' | 'interactive' = 'autonomous';
  @property({ type: Boolean }) loading = false;

  static styles = css`
    :host {
      display: block;
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
      font-size: 12px;
      color: #ccc;
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .filter-label {
      color: #666;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.06em;
    }
    .pill {
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      border-radius: 999px;
      color: #ccc;
      cursor: pointer;
      font: inherit;
      padding: 3px 10px;
    }
    .pill.selected {
      border-color: #6366f1;
      color: #fff;
      background: #232345;
    }
    .pill:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .result-count {
      margin-left: auto;
      color: #888;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      color: #666;
      font-weight: normal;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 4px 8px;
      border-bottom: 1px solid #2a2a3e;
    }
    td {
      padding: 5px 8px;
      border-bottom: 1px solid #1a1a2e;
      vertical-align: top;
    }
    tr.row {
      cursor: pointer;
    }
    tr.row:hover {
      background: #12121a;
    }
    tr.row.selected {
      background: #1c1c38;
      outline: 1px solid #6366f1;
      outline-offset: -1px;
    }
    .tpl-title {
      color: #fff;
    }
    .tpl-id,
    .provenance {
      color: #888;
      font-size: 11px;
    }
    .badge {
      border: 1px solid #2a2a3e;
      border-radius: 3px;
      color: #9ca3af;
      font-size: 10px;
      padding: 0 4px;
      margin-right: 3px;
    }
    .badge.default {
      border-color: #00ff88;
      color: #00ff88;
    }
    .preview-btn {
      background: none;
      border: none;
      color: #6366f1;
      cursor: pointer;
      padding: 2px;
    }
    .empty,
    .notice {
      color: #ffcc00;
      padding: 6px 2px;
    }
    .selection-summary {
      color: #888;
      padding: 4px 2px;
    }
    .invalid {
      color: #ff4444;
    }
  `;

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private whenReady(action: () => void): void {
    if (!this.loading) action();
  }

  private renderRow(row: ExecutionTemplatePickerRow) {
    const option = row.option;
    return html`<tr
      class="row ${row.selected ? 'selected' : ''}"
      aria-selected=${row.selected ? 'true' : 'false'}
      @click=${() => this.whenReady(() => this.emit('template-select', { id: option.id }))}
    >
      <td>
        <div class="tpl-title">
          ${option.title}${row.gatewayDefault
            ? html` <span class="badge default">default</span>`
            : nothing}
        </div>
        <div class="tpl-id">${option.id}</div>
      </td>
      <td>${option.sourceId}</td>
      <td>${row.domains.length > 0 ? row.domains.join(', ') : 'general'}</td>
      <td>${option.runMode ?? 'any'}</td>
      <td>${option.platforms.join('/')}</td>
      <td>
        <div class="provenance" title=${option.sha256}>${option.sha256.slice(0, 12)}</div>
      </td>
      <td>
        <button
          class="preview-btn"
          title=${`Preview ${option.title}`}
          aria-label=${`Preview ${option.title}`}
          ?disabled=${this.loading}
          @click=${(event: MouseEvent) => {
            event.stopPropagation();
            this.whenReady(() =>
              this.emit('template-preview', {
                option,
                trigger: event.currentTarget as HTMLElement,
              }),
            );
          }}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
            <circle cx="12" cy="12" r="2.8"></circle>
          </svg>
        </button>
      </td>
    </tr>`;
  }

  render() {
    if (!this.catalog) return nothing;
    const view = deriveExecutionTemplatePickerView(this.catalog, this.selectedId, {
      domain: this.domain,
      runMode: this.mode,
    });
    const domains = this.catalog.availableDomains;
    return html`
      <div class="filters" aria-busy=${this.loading ? 'true' : 'false'}>
        ${domains.length > 0
          ? html`<span class="filter-label">Domain</span>
              <button
                class="pill ${this.domain === '' ? 'selected' : ''}"
                ?disabled=${this.loading}
                @click=${() => this.whenReady(() => this.emit('domain-change', { domain: '' }))}
              >
                general
              </button>
              ${domains.map(
                (domain) =>
                  html`<button
                    class="pill ${this.domain === domain ? 'selected' : ''}"
                    ?disabled=${this.loading}
                    @click=${() => this.whenReady(() => this.emit('domain-change', { domain }))}
                  >
                    ${domain}
                  </button>`,
              )}`
          : nothing}
        <span class="filter-label">Mode</span>
        ${
          /* 'validation' is a recipe-harness run mode, never operator-dispatched,
            so the picker offers only the two dispatchable modes. */
          (['autonomous', 'interactive'] as const).map(
            (mode) =>
              html`<button
                class="pill ${this.mode === mode ? 'selected' : ''}"
                ?disabled=${this.loading}
                @click=${() => this.whenReady(() => this.emit('mode-change', { mode }))}
              >
                ${mode}
              </button>`,
          )
        }
        <span class="result-count" data-testid="picker-result-count">
          ${view.resultCount} compatible · ${view.activeFilterSummary}
        </span>
      </div>
      ${view.emptyStateMessage
        ? html`<div class="empty" data-testid="picker-empty">${view.emptyStateMessage}</div>`
        : html`<table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Source</th>
                <th>Domains</th>
                <th>Mode</th>
                <th>Platforms</th>
                <th>Digest</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${view.rows.map((row) => this.renderRow(row))}
            </tbody>
          </table>`}
      ${view.sourceNotices.map(
        (notice) => html`<div class="notice" data-testid="picker-source-notice">${notice}</div>`,
      )}
      ${!view.selectionValid
        ? html`<div class="invalid" data-testid="picker-selection-invalid">
            Previous selection "${this.selectedId}" is not compatible with
            ${view.activeFilterSummary}.
          </div>`
        : nothing}
      ${view.selectionSummary
        ? html`<div class="selection-summary" data-testid="picker-selection-summary">
            ${view.selectionSummary} · gateway validates the exact source and digest before claiming
            the slot.
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'execution-template-picker': ExecutionTemplatePicker;
  }
}
