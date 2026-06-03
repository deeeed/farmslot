import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { TaskSchema, TaskSchemaPhase } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightPlaceholders(text: string): string {
  return escapeHtml(text).replace(/\{\{(\w+)\}\}/g, '<span class="placeholder">{{$1}}</span>');
}

@customElement('template-schema')
export class TemplateSchema extends LitElement {
  @property({ attribute: false }) schema?: TaskSchema;
  @property({ attribute: false }) placeholders: string[] = [];

  @state() private _expandedPhases = new Set<string>();

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .summary {
      display: flex;
      gap: ${unsafeCSS(spacing.lg)};
      margin-bottom: ${unsafeCSS(spacing.lg)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }

    .summary-item {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .summary-value {
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }

    .phase {
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }

    .phase-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      padding: 6px ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.sm)};
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }

    .phase-header:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }

    .phase-arrow {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      transition: transform 0.15s;
      width: 12px;
      text-align: center;
    }

    .phase-arrow.expanded {
      transform: rotate(90deg);
    }

    .phase-name {
      flex: 1;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }

    .phase-count {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .phase-steps {
      padding-left: 20px;
      margin-top: ${unsafeCSS(spacing.xs)};
    }

    .step {
      display: flex;
      align-items: baseline;
      gap: ${unsafeCSS(spacing.sm)};
      padding: 3px 0;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .step-index {
      color: ${unsafeCSS(colors.textMuted)};
      min-width: 20px;
      text-align: right;
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .step-icon {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
    }

    .placeholder-list {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.sm)};
      margin-top: ${unsafeCSS(spacing.md)};
      padding-top: ${unsafeCSS(spacing.md)};
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
    }

    .placeholder-tag {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 2px 6px;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
    }

    .step-name .placeholder {
      color: ${unsafeCSS(colors.accent)};
    }
  `;

  private togglePhase(name: string) {
    const next = new Set(this._expandedPhases);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this._expandedPhases = next;
  }

  private renderPhase(phase: TaskSchemaPhase) {
    const expanded = this._expandedPhases.has(phase.name);
    return html`
      <div class="phase">
        <div class="phase-header" @click=${() => this.togglePhase(phase.name)}>
          <span class="phase-arrow ${expanded ? 'expanded' : ''}">▶</span>
          <span class="phase-name">${phase.name}</span>
          <span class="phase-count"
            >${phase.steps.length} step${phase.steps.length !== 1 ? 's' : ''}</span
          >
        </div>
        ${expanded
          ? html`
              <div class="phase-steps">
                ${phase.steps.map(
                  (step) => html`
                    <div class="step">
                      <span class="step-index">${step.index}</span>
                      <span class="step-icon">○</span>
                      <span class="step-name">${unsafeHTML(highlightPlaceholders(step.name))}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  render() {
    if (!this.schema) return nothing;
    return html`
      <div class="summary">
        <span class="summary-item"
          ><span class="summary-value">${this.schema.phases.length}</span> phases</span
        >
        <span class="summary-item"
          ><span class="summary-value">${this.schema.totalSteps}</span> steps</span
        >
        <span class="summary-item"
          ><span class="summary-value">${this.placeholders.length}</span> placeholders</span
        >
      </div>
      ${this.schema.phases.map((p) => this.renderPhase(p))}
      ${this.placeholders.length > 0
        ? html`
            <div class="placeholder-list">
              ${this.placeholders.map((p) => html`<span class="placeholder-tag">{{${p}}}</span>`)}
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'template-schema': TemplateSchema;
  }
}
