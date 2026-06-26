import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import type { PrepareProgressState } from './prepare-progress-model.js';

@customElement('prepare-progress-panel')
export class PrepareProgressPanel extends LitElement {
  @property({ attribute: false }) state: PrepareProgressState | null = null;
  @property({ type: Boolean }) compact = false;

  static override styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .ppp-wrap {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      overflow: hidden;
    }
    .ppp-header {
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid #2a2a44;
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: center;
      flex-wrap: wrap;
    }
    .ppp-title {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .ppp-meta {
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .ppp-status {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2px 7px;
      border-radius: ${unsafeCSS(radii.sm)};
    }
    .ppp-status.running {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
    }
    .ppp-status.done {
      background: ${unsafeCSS(colors.statusOk)}22;
      color: ${unsafeCSS(colors.statusOk)};
    }
    .ppp-status.failed {
      background: ${unsafeCSS(colors.statusFail)}22;
      color: ${unsafeCSS(colors.statusFail)};
    }
    .ppp-steps {
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid #2a2a44;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 160px;
      overflow-y: auto;
    }
    .ppp-step {
      font-size: 11px;
      color: ${unsafeCSS(colors.textSecondary)};
      line-height: 1.4;
    }
    .ppp-step-name {
      color: ${unsafeCSS(colors.accent)};
      font-weight: 700;
      margin-right: 6px;
    }
    .ppp-log {
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      background: #000;
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.4;
      white-space: pre-wrap;
      max-height: 220px;
      overflow-y: auto;
    }
    .ppp-error {
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.statusWarn)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      border-top: 1px solid #2a2a44;
    }
    :host([compact]) .ppp-log {
      max-height: 120px;
    }
    :host([compact]) .ppp-steps {
      max-height: 96px;
    }
  `;

  override render() {
    const state = this.state;
    if (!state) return nothing;
    const status = state.running
      ? 'running'
      : state.exitCode === 0
        ? 'done'
        : state.exitCode !== null
          ? 'failed'
          : 'running';
    const latestStep = state.steps[state.steps.length - 1];
    return html`
      <div class="ppp-wrap">
        <div class="ppp-header">
          <div>
            <div class="ppp-title">${state.label}</div>
            <div class="ppp-meta">
              ${state.slotId} · ${state.requestId.slice(0, 20)}
              ${latestStep ? ` · ${latestStep.name}` : ''}
            </div>
          </div>
          <span class="ppp-status ${status}"
            >${state.running ? 'Running' : state.exitCode === 0 ? 'Done' : 'Failed'}</span
          >
        </div>
        ${state.steps.length > 0
          ? html`<div class="ppp-steps">
              ${state.steps.slice(-12).map(
                (step) => html`
                  <div class="ppp-step">
                    <span class="ppp-step-name">${step.name}</span>${step.detail}
                  </div>
                `,
              )}
            </div>`
          : nothing}
        ${state.lines.length > 0
          ? html`<div class="ppp-log">${state.lines.slice(-40).join('\n')}</div>`
          : nothing}
        ${state.error
          ? html`<div class="ppp-error">${state.error}</div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'prepare-progress-panel': PrepareProgressPanel;
  }
}