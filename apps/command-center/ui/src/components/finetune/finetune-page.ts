import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  FinetuneExportDPOResult,
  FinetuneExportSFTResult,
  FinetuneIndexResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

type Tab = 'index' | 'sft' | 'dpo';

function gradeColor(g?: string): string {
  if (g === 'good') return colors.statusOk;
  if (g === 'ok') return colors.statusWarn;
  if (g === 'bad') return colors.statusFail;
  return colors.textMuted;
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

@customElement('finetune-page')
export class FinetunePage extends LitElement {
  @state() private tab: Tab = 'index';
  @state() private indexData: FinetuneIndexResult | null = null;
  @state() private sftData: FinetuneExportSFTResult | null = null;
  @state() private dpoData: FinetuneExportDPOResult | null = null;
  @state() private loading = false;
  @state() private projectFilter = '';
  @state() private minGrade = '';

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      padding: ${unsafeCSS(spacing.lg)};
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.lg)};
      margin-bottom: ${unsafeCSS(spacing.lg)};
    }
    h2 {
      margin: 0;
      font-size: ${unsafeCSS(fonts.sizeLg)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .tabs {
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .tab {
      padding: 4px 10px;
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid transparent;
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      cursor: pointer;
    }
    .tab:hover {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .tab.active {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}44;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .toolbar select,
    .toolbar input {
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 3px 6px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .btn {
      padding: 4px 12px;
      background: ${unsafeCSS(colors.accent)};
      color: #fff;
      border: none;
      border-radius: ${unsafeCSS(radii.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      cursor: pointer;
    }
    .btn:hover {
      background: ${unsafeCSS(colors.accentHover)};
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .btn-secondary {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .btn-secondary:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .stats {
      display: flex;
      gap: ${unsafeCSS(spacing.xl)};
      margin-bottom: ${unsafeCSS(spacing.lg)};
      padding: ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: ${unsafeCSS(radii.md)};
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: ${unsafeCSS(fonts.sizeLg)};
      font-weight: 700;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .stat-label {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    th {
      text-align: left;
      color: ${unsafeCSS(colors.textMuted)};
      font-weight: 600;
      padding: 4px 8px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      text-transform: uppercase;
    }
    td {
      padding: 4px 8px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)}22;
      color: ${unsafeCSS(colors.textSecondary)};
    }
    tr:hover td {
      background: ${unsafeCSS(colors.bgCard)}44;
    }
    .grade-pill {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 600;
    }
    .empty {
      text-align: center;
      padding: ${unsafeCSS(spacing.xxl)};
      color: ${unsafeCSS(colors.textMuted)};
    }
    .pair-card {
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .pair-header {
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .pair-row {
      display: flex;
      gap: ${unsafeCSS(spacing.xl)};
    }
    .pair-side {
      flex: 1;
      padding: ${unsafeCSS(spacing.sm)};
      border-radius: ${unsafeCSS(radii.sm)};
    }
    .pair-chosen {
      border-left: 3px solid ${unsafeCSS(colors.statusOk)};
    }
    .pair-rejected {
      border-left: 3px solid ${unsafeCSS(colors.statusFail)};
    }
    .pair-label {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      text-transform: uppercase;
      color: ${unsafeCSS(colors.textMuted)};
      margin-bottom: 2px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.loadIndex();
  }

  private async loadIndex() {
    this.loading = true;
    try {
      this.indexData = await gateway.request<FinetuneIndexResult>(Methods.FINETUNE_INDEX, {
        project: this.projectFilter || undefined,
      });
    } catch (err) {
      console.error('[finetune] index load failed:', err);
    }
    this.loading = false;
  }

  private async loadSFT() {
    this.loading = true;
    try {
      this.sftData = await gateway.request<FinetuneExportSFTResult>(Methods.FINETUNE_EXPORT_SFT, {
        project: this.projectFilter || undefined,
        minGrade: this.minGrade || undefined,
      });
    } catch (err) {
      console.error('[finetune] SFT export failed:', err);
    }
    this.loading = false;
  }

  private async loadDPO() {
    this.loading = true;
    try {
      this.dpoData = await gateway.request<FinetuneExportDPOResult>(Methods.FINETUNE_EXPORT_DPO, {
        project: this.projectFilter || undefined,
      });
    } catch (err) {
      console.error('[finetune] DPO export failed:', err);
    }
    this.loading = false;
  }

  private switchTab(t: Tab) {
    this.tab = t;
    if (t === 'index' && !this.indexData) this.loadIndex();
    if (t === 'sft' && !this.sftData) this.loadSFT();
    if (t === 'dpo' && !this.dpoData) this.loadDPO();
  }

  private renderStats() {
    const s = this.indexData?.stats;
    if (!s) return nothing;
    return html`
      <div class="stats">
        <div class="stat">
          <div class="stat-value">${s.total}</div>
          <div class="stat-label">Total</div>
        </div>
        <div class="stat">
          <div class="stat-value">${s.graded}</div>
          <div class="stat-label">Graded</div>
        </div>
        <div class="stat">
          <div class="stat-value" style="color:${colors.statusOk}">${s.good}</div>
          <div class="stat-label">Good</div>
        </div>
        <div class="stat">
          <div class="stat-value" style="color:${colors.statusWarn}">${s.ok}</div>
          <div class="stat-label">OK</div>
        </div>
        <div class="stat">
          <div class="stat-value" style="color:${colors.statusFail}">${s.bad}</div>
          <div class="stat-label">Bad</div>
        </div>
      </div>
    `;
  }

  private renderIndexTab() {
    const runs = this.indexData?.runs ?? [];
    return html`
      ${this.renderStats()}
      ${runs.length === 0
        ? html`<div class="empty">No completed runs found</div>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Flow</th>
                  <th>Ticket</th>
                  <th>Outcome</th>
                  <th>Grade</th>
                  <th>Model</th>
                  <th>Steps</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(
                  (r) => html`
                    <tr>
                      <td>
                        <a href="#run/${r.id}" style="color:${colors.accent}"
                          >${r.id.slice(0, 8)}</a
                        >
                      </td>
                      <td>${r.flowType}</td>
                      <td>${r.ticketOrPr}</td>
                      <td>${r.outcome}</td>
                      <td>
                        ${r.humanGrade
                          ? html`<span
                              class="grade-pill"
                              style="background:${gradeColor(r.humanGrade)}33;color:${gradeColor(
                                r.humanGrade,
                              )}"
                              >${r.humanGrade}</span
                            >`
                          : html`<span style="color:${colors.textMuted}">--</span>`}
                      </td>
                      <td>${r.model}</td>
                      <td>${r.stepCount}</td>
                      <td>${r.durationMs > 0 ? `${Math.round(r.durationMs / 1000)}s` : '--'}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    `;
  }

  private renderSFTTab() {
    const count = this.sftData?.examples.length ?? 0;
    return html`
      <div class="toolbar">
        <label style="color:${colors.textMuted};font-size:${fonts.sizeXs}">Min grade:</label>
        <select
          .value=${this.minGrade}
          @change=${(e: Event) => {
            this.minGrade = (e.target as HTMLSelectElement).value;
          }}
        >
          <option value="">Any</option>
          <option value="bad">bad+</option>
          <option value="ok">ok+</option>
          <option value="good">good</option>
        </select>
        <button class="btn btn-secondary" @click=${() => this.loadSFT()} ?disabled=${this.loading}>
          Refresh
        </button>
        <button
          class="btn"
          @click=${() =>
            this.sftData && downloadJson(this.sftData.examples, `sft-export-${Date.now()}.json`)}
          ?disabled=${!count}
        >
          Export SFT (${count})
        </button>
      </div>
      ${count === 0
        ? html`<div class="empty">
            No graded runs match the filter. Grade runs first via the Runs page.
          </div>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Flow</th>
                  <th>Ticket</th>
                  <th>Label</th>
                  <th>Steps</th>
                </tr>
              </thead>
              <tbody>
                ${this.sftData!.examples.map(
                  (ex) => html`
                    <tr>
                      <td>
                        <a href="#run/${ex.runId}" style="color:${colors.accent}"
                          >${ex.runId.slice(0, 8)}</a
                        >
                      </td>
                      <td>${ex.flowType}</td>
                      <td>${ex.ticketOrPr}</td>
                      <td>
                        <span
                          class="grade-pill"
                          style="background:${gradeColor(ex.label)}33;color:${gradeColor(ex.label)}"
                          >${ex.label}</span
                        >
                      </td>
                      <td>${Object.keys(ex.output.stepOutputs ?? {}).length}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    `;
  }

  private renderDPOTab() {
    const count = this.dpoData?.pairs.length ?? 0;
    return html`
      <div class="toolbar">
        <button class="btn btn-secondary" @click=${() => this.loadDPO()} ?disabled=${this.loading}>
          Refresh
        </button>
        <button
          class="btn"
          @click=${() =>
            this.dpoData && downloadJson(this.dpoData.pairs, `dpo-export-${Date.now()}.json`)}
          ?disabled=${!count}
        >
          Export DPO (${count} pairs)
        </button>
      </div>
      ${count === 0
        ? html`<div class="empty">
            No DPO pairs found. Need multiple runs for the same ticket with different grades.
          </div>`
        : this.dpoData!.pairs.map(
            (p) => html`
              <div class="pair-card">
                <div class="pair-header">${p.ticketOrPr}</div>
                <div class="pair-row">
                  <div class="pair-side pair-chosen">
                    <div class="pair-label">Chosen</div>
                    <div>
                      ${p.chosen.runId.slice(0, 8)} / ${p.chosen.model} /
                      <span
                        class="grade-pill"
                        style="background:${gradeColor(p.chosen.grade)}33;color:${gradeColor(
                          p.chosen.grade,
                        )}"
                        >${p.chosen.grade}</span
                      >
                    </div>
                  </div>
                  <div class="pair-side pair-rejected">
                    <div class="pair-label">Rejected</div>
                    <div>
                      ${p.rejected.runId.slice(0, 8)} / ${p.rejected.model} /
                      <span
                        class="grade-pill"
                        style="background:${gradeColor(p.rejected.grade)}33;color:${gradeColor(
                          p.rejected.grade,
                        )}"
                        >${p.rejected.grade}</span
                      >
                    </div>
                  </div>
                </div>
              </div>
            `,
          )}
    `;
  }

  render() {
    return html`
      <div class="header">
        <h2>Fine-Tuning Data</h2>
        <div class="tabs">
          ${(['index', 'sft', 'dpo'] as Tab[]).map(
            (t) => html`
              <button
                class="tab ${this.tab === t ? 'active' : ''}"
                @click=${() => this.switchTab(t)}
              >
                ${t === 'index' ? 'Index' : t === 'sft' ? 'SFT Export' : 'DPO Pairs'}
              </button>
            `,
          )}
        </div>
        <div style="flex:1"></div>
        <div class="toolbar" style="margin-bottom:0">
          <label style="color:${colors.textMuted};font-size:${fonts.sizeXs}">Project:</label>
          <input
            type="text"
            placeholder="all"
            .value=${this.projectFilter}
            @change=${(e: Event) => {
              this.projectFilter = (e.target as HTMLInputElement).value;
              this.loadIndex();
            }}
          />
        </div>
      </div>
      ${this.loading ? html`<div class="empty">Loading...</div>` : nothing}
      ${this.tab === 'index' ? this.renderIndexTab() : nothing}
      ${this.tab === 'sft' ? this.renderSFTTab() : nothing}
      ${this.tab === 'dpo' ? this.renderDPOTab() : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'finetune-page': FinetunePage;
  }
}
