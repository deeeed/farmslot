// Reusable execution-template catalog picker (MANUAL-000076 UX addendum).
// Renders a catalog snapshot as a filterable table. Domain, run-mode, flow,
// and platform filters run locally. Selection changes are emitted as events;
// the host owns state. The gateway still validates source and digest at claim.
import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { ExecutionTemplateCatalogOption, ExecutionTemplateOptions } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

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
  @property() flow = '';
  @property() platform = '';
  @property({ type: Boolean }) loading = false;

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .filter-label {
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      letter-spacing: 0.06em;
    }
    .pill {
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 999px;
      color: ${unsafeCSS(colors.textPrimary)};
      cursor: pointer;
      font: inherit;
      padding: 3px 10px;
    }
    .pill.selected {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.textPrimary)};
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .pill:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .result-count {
      margin-left: auto;
      color: ${unsafeCSS(colors.textSecondary)};
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      color: ${unsafeCSS(colors.textMuted)};
      font-weight: normal;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }
    td {
      padding: 5px ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      vertical-align: top;
    }
    tr.row {
      cursor: pointer;
    }
    tr.row:hover {
      background: ${unsafeCSS(colors.bgSurface)};
    }
    tr.row.selected {
      background: ${unsafeCSS(colors.bgCardHover)};
      outline: 1px solid ${unsafeCSS(colors.accent)};
      outline-offset: -1px;
    }
    .tpl-title {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .tpl-id,
    .provenance {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .tpl-description {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      max-width: 46ch;
    }
    .badge {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 0 ${unsafeCSS(spacing.sm)};
      margin-right: ${unsafeCSS(spacing.xs)};
    }
    .badge.default {
      border-color: ${unsafeCSS(colors.statusOk)};
      color: ${unsafeCSS(colors.statusOk)};
    }
    .preview-btn {
      background: none;
      border: none;
      color: ${unsafeCSS(colors.accent)};
      cursor: pointer;
      padding: ${unsafeCSS(spacing.xs)};
    }
    .empty,
    .notice {
      color: ${unsafeCSS(colors.statusWarn)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.xs)};
    }
    .selection-summary {
      color: ${unsafeCSS(colors.textSecondary)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.xs)};
    }
    .invalid {
      color: ${unsafeCSS(colors.statusFail)};
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
      tabindex="0"
      role="row"
      aria-selected=${row.selected ? 'true' : 'false'}
      @click=${() => this.whenReady(() => this.emit('template-select', { id: option.id }))}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.whenReady(() => this.emit('template-select', { id: option.id }));
      }}
    >
      <td>
        <div class="tpl-title">
          ${option.title}${row.gatewayDefault
            ? html` <span class="badge default">default</span>`
            : nothing}
        </div>
        <div class="tpl-id">${option.id}</div>
        ${option.description
          ? html`<div class="tpl-description">${option.description}</div>`
          : nothing}
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
      ...(this.flow ? { flow: this.flow } : {}),
      ...(this.platform ? { platform: this.platform } : {}),
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
