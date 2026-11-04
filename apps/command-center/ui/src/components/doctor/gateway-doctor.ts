import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  GatewayDoctorResult,
  GatewayDoctorSectionDefinition,
  GatewayDoctorSectionId,
  GatewayDoctorSectionReport,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';
import { type PerformanceSnapshot, slowestActions } from '@farmslot/protocol/performance';

import { gateway, gatewayStatusMessage } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { readViewChoice, viewChoiceHash } from '../../utils/url-state.js';

const performanceView = { route: 'doctor', param: 'slowest', defaultValue: 'closed' };

@customElement('gateway-doctor')
export class GatewayDoctor extends LitElement {
  @state() private sections: GatewayDoctorSectionReport[] = [];
  @state() private performanceSnapshot?: PerformanceSnapshot;
  @state() private performanceError = '';
  @state() private performanceLoading = false;
  @state() private performanceOpen = readViewChoice(performanceView) === 'open';
  private readonly restoreView = () => {
    this.performanceOpen = readViewChoice(performanceView) === 'open';
  };
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
      min-height: 44px;
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
      white-space: pre-line;
      line-height: 1.5;
    }
    .performance-table {
      width: 100%;
      border-spacing: 12px;
      text-align: left;
    }
    .performance-table td {
      vertical-align: top;
    }
    @media (max-width: 600px) {
      .performance-table,
      .performance-table tbody,
      .performance-table tr,
      .performance-table td {
        display: block;
      }
      .performance-table thead {
        display: none;
      }
      .performance-table tr {
        padding: 12px 0;
        border-top: 1px solid ${unsafeCSS(colors.bgCardHover)};
      }
      .performance-table td {
        padding: 4px 0;
        overflow-wrap: anywhere;
      }
      .performance-table td[data-label]::before {
        content: attr(data-label) ': ';
        color: ${unsafeCSS(colors.textSecondary)};
      }
    }
    .section-placeholder {
      padding: ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.textMuted)};
      line-height: 1.5;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.restoreView();
    window.addEventListener('hashchange', this.restoreView);
    window.addEventListener('popstate', this.restoreView);
    this.unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected' && !this.hasCompletedSection())
        void this.loadCatalogAndRefreshAll();
    });
    if (gateway.connectionState === 'connected') void this.loadCatalogAndRefreshAll();
    else this.error = gatewayStatusMessage(gateway);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.restoreView);
    window.removeEventListener('popstate', this.restoreView);
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
      this.error = gatewayStatusMessage(gateway);
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
      this.error = gatewayStatusMessage(gateway);
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
      this.error = gatewayStatusMessage(gateway);
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

  private async refreshPerformance(): Promise<void> {
    this.performanceLoading = true;
    this.performanceError = '';
    try {
      this.performanceSnapshot = await gateway.request<PerformanceSnapshot>(
        Methods.GATEWAY_PERFORMANCE_GET,
        {},
      );
    } catch (error) {
      this.performanceError = error instanceof Error ? error.message : String(error);
    } finally {
      this.performanceLoading = false;
    }
  }

  render() {
    const summary = doctorSummary(this.sections);
    const actions = this.performanceSnapshot ? slowestActions(this.performanceSnapshot) : [];
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
      <details
        class="section"
        ?open=${this.performanceOpen}
        @toggle=${(event: Event) => {
          const open = (event.target as HTMLDetailsElement).open;
          this.performanceOpen = open;
          const next = viewChoiceHash(performanceView, open ? 'open' : 'closed');
          if (location.hash !== next) history.pushState(null, '', next);
          if (open && !this.performanceSnapshot && !this.performanceLoading)
            void this.refreshPerformance();
        }}
      >
        <summary style="padding:12px;min-height:44px;box-sizing:border-box">
          Slowest actions
        </summary>
        <div style="padding:12px;overflow:auto">
          <button @click=${() => this.refreshPerformance()} ?disabled=${this.performanceLoading}>
            ${this.performanceLoading ? 'Reading…' : 'Refresh measurements'}
          </button>
          ${this.performanceError ? html`<p class="fail">${this.performanceError}</p>` : nothing}
          ${this.performanceSnapshot
            ? html`
                <p class="meta">
                  Since ${new Date(this.performanceSnapshot.startedAtMs).toLocaleString()} ·
                  ${this.performanceSnapshot.dropped} dropped samples. Percentiles use histogram
                  buckets.
                </p>
                ${actions.length
                  ? html`<table class="performance-table">
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>Count</th>
                          <th>p50 / p95 / max</th>
                          <th>p95 budget</th>
                          <th>Bytes</th>
                          <th>Processes / node calls</th>
                          <th>Observed cause</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${actions.slice(0, 20).map(
                          (row) =>
                            html`<tr>
                              <td>
                                ${row.method}
                                <div class="meta">
                                  ${row.side} ·
                                  ${row.phase}${row.cacheSource
                                    ? html` · ${row.cacheSource}`
                                    : nothing}
                                  · ${row.actionClass ?? 'gateway'}
                                </div>
                              </td>
                              <td data-label="Count">${row.count}</td>
                              <td data-label="p50 / p95 / max">
                                ${(row.p50 * 1000).toFixed(0)} / ${(row.p95 * 1000).toFixed(0)} /
                                ${(row.max * 1000).toFixed(0)} ms
                              </td>
                              <td data-label="p95 budget">
                                ${row.budgetStatus ?? 'unmeasured'}${row.budgetSeconds !== undefined
                                  ? html`<div class="meta">${row.budgetSeconds * 1000} ms</div>`
                                  : nothing}
                              </td>
                              <td data-label="Bytes">
                                ${row.bytesMeasured
                                  ? html`${Math.round(row.bytes / row.count)} / call`
                                  : html`Unmeasured`}
                              </td>
                              <td data-label="Processes / node calls">
                                ${row.processesMeasured
                                  ? html`${row.execCount} / ${row.nodeCount}
                                      <div class="meta">
                                        process ${row.execSeconds.toFixed(2)} s · node
                                        ${row.nodeSeconds.toFixed(2)} s · reconnect
                                        ${row.nodeWaitSeconds.toFixed(2)} s · loop max
                                        ${row.loopLagSeconds.toFixed(3)} s
                                      </div>`
                                  : html`Unmeasured`}
                              </td>
                              <td data-label="Observed cause">${row.causes.join(', ')}</td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>`
                  : html`<p class="meta">No requests measured yet.</p>`}
              `
            : nothing}
        </div>
      </details>
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
