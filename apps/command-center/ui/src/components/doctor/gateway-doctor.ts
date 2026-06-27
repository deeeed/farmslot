import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type { GatewayDoctorResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

@customElement('gateway-doctor')
export class GatewayDoctor extends LitElement {
  @state() private result: GatewayDoctorResult | null = null;
  @state() private loading = false;
  @state() private error = '';
  private unsubscribeConnection: (() => void) | null = null;

  static styles = css`
    :host {
      display: block;
      padding: ${unsafeCSS(spacing.lg)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      align-items: flex-start;
      margin-bottom: ${unsafeCSS(spacing.lg)};
    }
    h1 {
      margin: 0 0 6px;
      font-size: 24px;
    }
    .copy,
    .meta {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.5;
    }
    button {
      border: 1px solid ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      border-radius: ${unsafeCSS(radii.md)};
      padding: 9px 12px;
      font: inherit;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .summary {
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
      margin-bottom: ${unsafeCSS(spacing.lg)};
      flex-wrap: wrap;
    }
    .pill {
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      background: ${unsafeCSS(colors.bgCard)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .ok {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .warn {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .fail {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .section {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: ${unsafeCSS(radii.lg)};
      margin-bottom: ${unsafeCSS(spacing.md)};
      overflow: hidden;
    }
    .section-title {
      padding: ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      font-weight: 800;
    }
    .check {
      display: grid;
      grid-template-columns: 90px 180px 1fr;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
      align-items: start;
    }
    .check:first-of-type {
      border-top: none;
    }
    .status {
      font-weight: 800;
      text-transform: uppercase;
    }
    .label {
      font-weight: 700;
    }
    .detail {
      color: ${unsafeCSS(colors.textSecondary)};
      line-height: 1.5;
    }
    .hint {
      color: ${unsafeCSS(colors.accent)};
      margin-top: 6px;
    }
    .error {
      border: 1px solid ${unsafeCSS(colors.statusFail)}66;
      background: ${unsafeCSS(colors.statusFail)}18;
      color: ${unsafeCSS(colors.statusFail)};
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.md)};
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected' && !this.result) void this.refresh();
    });
    if (gateway.connectionState === 'connected') void this.refresh();
    else this.error = 'Waiting for gateway connection…';
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
  }

  private async refresh(): Promise<void> {
    if (gateway.connectionState !== 'connected') {
      this.error = 'Waiting for gateway connection…';
      return;
    }
    this.loading = true;
    this.error = '';
    try {
      this.result = await gateway.request<GatewayDoctorResult>(Methods.GATEWAY_DOCTOR, {}, 30_000);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  render() {
    return html`
      <div class="header">
        <div>
          <h1>Gateway Doctor</h1>
          <div class="copy">
            Validates the hosted Command Center connection to your local gateway, projects, slots,
            nodes, evidence capture, browser/CDP, simulator, and ADB setup.
          </div>
          <div class="meta">Connected gateway: ${gateway.gatewayUrl}</div>
        </div>
        <button @click=${() => this.refresh()} ?disabled=${this.loading}>
          ${this.loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${this.result ? this.renderResult(this.result) : nothing}
    `;
  }

  private renderResult(result: GatewayDoctorResult) {
    return html`
      <div class="summary">
        <span class="pill ok">${result.summary.ok} passing</span>
        <span class="pill warn">${result.summary.warn} warnings</span>
        <span class="pill fail">${result.summary.fail} failing</span>
        <span class="pill">${new Date(result.generatedAt).toLocaleTimeString()}</span>
      </div>
      ${result.sections.map(
        (section) => html`
          <section class="section">
            <div class="section-title">${section.label}</div>
            ${section.checks.map(
              (check) => html`
                <div class="check">
                  <div class="status ${check.ok ? (check.warn ? 'warn' : 'ok') : 'fail'}">
                    ${check.ok ? (check.warn ? 'warn' : 'ok') : 'fail'}
                  </div>
                  <div class="label">${check.label}</div>
                  <div class="detail">
                    ${check.detail}
                    ${check.hint ? html`<div class="hint">${check.hint}</div>` : nothing}
                  </div>
                </div>
              `,
            )}
          </section>
        `,
      )}
    `;
  }
}
