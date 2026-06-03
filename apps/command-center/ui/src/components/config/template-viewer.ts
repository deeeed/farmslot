import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ConfigTemplatesResult, TemplatePreview } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import './template-schema.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

type ViewTab = 'schema' | 'raw';

@customElement('template-viewer')
export class TemplateViewer extends LitElement {
  @property() project = '';

  @state() private _templates: TemplatePreview[] = [];
  @state() private _selectedFlow = '';
  @state() private _tab: ViewTab = 'schema';
  @state() private _loading = false;
  @state() private _error = '';

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      flex-wrap: wrap;
    }

    .flow-pills {
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
      flex-wrap: wrap;
    }

    .flow-pill {
      padding: 4px 10px;
      border-radius: ${unsafeCSS(radii.md)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      cursor: pointer;
      transition:
        background 0.15s,
        color 0.15s,
        border-color 0.15s;
    }

    .flow-pill:hover {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .flow-pill.active {
      background: ${unsafeCSS(colors.accent)}22;
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }

    .tab-divider {
      flex: 1;
    }

    .tab-group {
      display: flex;
      gap: 0;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.sm)};
      overflow: hidden;
    }

    .tab-btn {
      padding: 4px 10px;
      border: none;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }

    .tab-btn.active {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .content {
      flex: 1;
      overflow: auto;
      padding: ${unsafeCSS(spacing.lg)};
    }

    .raw-content {
      flex: 1;
      overflow: auto;
      padding: ${unsafeCSS(spacing.lg)};
    }

    .raw-content pre {
      margin: 0;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
    }

    .empty {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: ${unsafeCSS(spacing.xl)};
      text-align: center;
    }

    .error {
      color: ${unsafeCSS(colors.statusFail)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: ${unsafeCSS(spacing.md)};
    }
  `;

  override updated(changed: Map<string, unknown>) {
    if (changed.has('project') && this.project) {
      this.fetchTemplates();
    }
  }

  private async fetchTemplates() {
    this._loading = true;
    this._error = '';
    try {
      const result = (await gateway.request(Methods.CONFIG_TEMPLATES, {
        project: this.project,
      })) as ConfigTemplatesResult;
      this._templates = result.templates;
      if (
        this._templates.length > 0 &&
        !this._templates.find((t) => t.flowType === this._selectedFlow)
      ) {
        this._selectedFlow = this._templates[0].flowType;
      }
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._loading = false;
    }
  }

  private get selectedTemplate(): TemplatePreview | undefined {
    return this._templates.find((t) => t.flowType === this._selectedFlow);
  }

  render() {
    if (!this.project) return html`<div class="empty">Select a project</div>`;
    if (this._loading) return html`<div class="empty">Loading templates...</div>`;
    if (this._error) return html`<div class="error">${this._error}</div>`;
    if (this._templates.length === 0)
      return html`<div class="empty">No templates found for ${this.project}</div>`;

    const tmpl = this.selectedTemplate;
    return html`
      <div class="toolbar">
        <div class="flow-pills">
          ${this._templates.map(
            (t) => html`
              <button
                class="flow-pill ${t.flowType === this._selectedFlow ? 'active' : ''}"
                @click=${() => {
                  this._selectedFlow = t.flowType;
                }}
              >
                ${t.flowType}
              </button>
            `,
          )}
        </div>
        <div class="tab-divider"></div>
        <div class="tab-group">
          <button
            class="tab-btn ${this._tab === 'schema' ? 'active' : ''}"
            @click=${() => {
              this._tab = 'schema';
            }}
          >
            Schema
          </button>
          <button
            class="tab-btn ${this._tab === 'raw' ? 'active' : ''}"
            @click=${() => {
              this._tab = 'raw';
            }}
          >
            Raw
          </button>
        </div>
      </div>
      ${tmpl
        ? this._tab === 'schema'
          ? html`<div class="content">
              <template-schema
                .schema=${tmpl.schema}
                .placeholders=${tmpl.placeholders}
              ></template-schema>
            </div>`
          : html`<div class="raw-content"><pre>${tmpl.rawMarkdown}</pre></div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'template-viewer': TemplateViewer;
  }
}
