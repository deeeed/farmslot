import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  GatewayDoctorResult,
  GatewayDoctorSectionDefinition,
  GatewayDoctorSectionId,
  GatewayDoctorSectionReport,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

@customElement('gateway-doctor')
export class GatewayDoctor extends LitElement {
  @state() private sections: GatewayDoctorSectionReport[] = [];
  @state() private loading = false;
  @state() private error = '';
  private unsubscribeConnection: (() => void) | null = null;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      padding: ${unsafeCSS(spacing.lg)};
      box-sizing: border-box;
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
    button.secondary {
      border-color: ${unsafeCSS(colors.bgCardHover)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      padding: 7px 10px;
      font-size: ${unsafeCSS(fonts.sizeSm)};
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
    .muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .section {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: ${unsafeCSS(radii.lg)};
      margin-bottom: ${unsafeCSS(spacing.md)};
      overflow: hidden;
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      font-weight: 800;
    }
    .section-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 500;
    }
    .section-description {
      padding: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.5;
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
      overflow-wrap: anywhere;
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
      margin-bottom: ${unsafeCSS(spacing.md)};
      overflow-wrap: anywhere;
    }
    .section-placeholder {
      padding: ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.textMuted)};
      line-height: 1.5;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected' && !this.hasCompletedSection())
        void this.loadCatalogAndRefreshAll();
    });
    if (gateway.connectionState === 'connected') void this.loadCatalogAndRefreshAll();
    else this.error = 'Waiting for gateway connection…';
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
  }

  private hasCompletedSection(): boolean {
    return this.sections.some((section) => section.status === 'complete');
  }

  private async loadCatalogAndRefreshAll(): Promise<void> {
    try {
      await this.loadCatalog();
      await this.refreshAll();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async loadCatalog(): Promise<GatewayDoctorSectionReport[]> {
    if (gateway.connectionState !== 'connected') {
      this.error = 'Waiting for gateway connection…';
      return [];
    }
    const result = await gateway.request<GatewayDoctorResult>(
      Methods.GATEWAY_DOCTOR,
      { run: false },
      10_000,
    );
    const sections = initialSectionStates(result.availableSections);
    this.sections = sections;
    this.error = '';
    return sections;
  }

  private async refreshAll(): Promise<void> {
    if (gateway.connectionState !== 'connected') {
      this.error = 'Waiting for gateway connection…';
      return;
    }
    this.loading = true;
    this.error = '';
    try {
      const sections = this.sections.length > 0 ? this.sections : await this.loadCatalog();
      this.sections = sections.map((section) => ({
        ...section,
        status: 'pending',
        section: null,
        error: '',
        checkedAt: null,
      }));
      for (const section of sections) {
        await this.refreshSection(section.id);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private async refreshSection(id: GatewayDoctorSectionId): Promise<void> {
    if (gateway.connectionState !== 'connected') {
      this.error = 'Waiting for gateway connection…';
      return;
    }
    this.updateSection(id, { status: 'running', error: '' });
    try {
      const result = await gateway.request<GatewayDoctorResult>(
        Methods.GATEWAY_DOCTOR,
        { sectionId: id },
        30_000,
      );
      const section = result.sections[0];
      if (!section) {
        throw new Error(`gateway.doctor returned no ${id} section`);
      }
      this.updateSection(id, {
        status: 'complete',
        section,
        error: '',
        checkedAt: result.generatedAt,
      });
    } catch (error) {
      this.updateSection(id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    }
  }

  private updateSection(
    id: GatewayDoctorSectionId,
    patch: Partial<GatewayDoctorSectionReport>,
  ): void {
    this.sections = this.sections.map((section) =>
      section.id === id ? { ...section, ...patch } : section,
    );
  }

  render() {
    const summary = doctorSummary(this.sections);
    return html`
      <div class="header">
        <div>
          <h1>Gateway Doctor</h1>
          <div class="copy">
            Validates the hosted Command Center connection to your local gateway, projects, slots,
            nodes, evidence capture, browser/CDP, simulator, and ADB setup. Sections refresh one at
            a time so slow checks do not freeze the whole page.
          </div>
          <div class="meta">Connected gateway: ${gateway.gatewayUrl}</div>
        </div>
        <button @click=${() => this.refreshAll()} ?disabled=${this.loading}>
          ${this.loading ? 'Checking…' : 'Refresh all'}
        </button>
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      <div class="summary">
        <span class="pill ok">${summary.ok} passing</span>
        <span class="pill warn">${summary.warn} warnings</span>
        <span class="pill fail">${summary.fail} failing</span>
        <span class="pill muted">${summary.running} running</span>
        <span class="pill muted">${summary.pending} pending</span>
      </div>
      ${this.sections.map((section) => this.renderSection(section))}
    `;
  }

  private renderSection(sectionState: GatewayDoctorSectionReport) {
    const section = sectionState.section;
    const statusLabel = sectionStatusLabel(sectionState);
    return html`
      <section class="section">
        <div class="section-title">
          <span>${sectionState.label}</span>
          <div class="section-actions">
            <span class=${sectionStatusClass(sectionState)}>${statusLabel}</span>
            ${sectionState.checkedAt
              ? html`<span>${new Date(sectionState.checkedAt).toLocaleTimeString()}</span>`
              : nothing}
            <button
              class="secondary"
              @click=${() => this.refreshSection(sectionState.id)}
              ?disabled=${sectionState.status === 'running'}
            >
              Retry
            </button>
          </div>
        </div>
        ${sectionState.error ? html`<div class="error">${sectionState.error}</div>` : nothing}
        ${sectionState.description
          ? html`<div class="section-description">${sectionState.description}</div>`
          : nothing}
        ${section
          ? section.checks.map(
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
            )
          : html`<div class="section-placeholder">${sectionPlaceholder(sectionState)}</div>`}
      </section>
    `;
  }
}

function initialSectionStates(
  definitions: GatewayDoctorSectionDefinition[],
): GatewayDoctorSectionReport[] {
  return definitions.map((section) => ({
    id: section.id,
    label: section.label,
    description: section.description,
    status: 'pending',
    section: null,
    error: '',
    checkedAt: null,
  }));
}

function doctorSummary(sections: GatewayDoctorSectionReport[]) {
  const checks = sections.flatMap((section) => section.section?.checks ?? []);
  return {
    ok: checks.filter((check) => check.ok && !check.warn).length,
    warn: checks.filter((check) => check.ok && check.warn).length,
    fail:
      checks.filter((check) => !check.ok).length +
      sections.filter((section) => section.status === 'error').length,
    running: sections.filter((section) => section.status === 'running').length,
    pending: sections.filter((section) => section.status === 'pending').length,
  };
}

function sectionStatusLabel(section: GatewayDoctorSectionReport): string {
  if (section.status === 'complete' && section.section) {
    const checks = section.section.checks;
    if (checks.some((check) => !check.ok)) return 'fail';
    if (checks.some((check) => check.warn)) return 'warn';
    return 'ok';
  }
  return section.status;
}

function sectionStatusClass(section: GatewayDoctorSectionReport): string {
  const label = sectionStatusLabel(section);
  if (label === 'ok') return 'ok';
  if (label === 'warn' || label === 'running') return 'warn';
  if (label === 'fail' || label === 'error') return 'fail';
  return 'muted';
}

function sectionPlaceholder(section: GatewayDoctorSectionReport): string {
  if (section.status === 'running') return 'Running checks for this section…';
  if (section.status === 'error') return 'Section failed before checks were returned.';
  return 'Pending — this section will run independently.';
}
