import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  type AnalyticsQueryParams,
  type AnalyticsQueryResult,
  type DurationStats,
  Methods,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { buildHash, parseHashRoute } from '../../utils/url-state.js';

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Dimension filters, in display order. `key` matches both AnalyticsQueryParams and the hash param. */
const DIMENSIONS = [
  { key: 'project', label: 'Project', dim: 'projects' },
  { key: 'host', label: 'Host', dim: 'hosts' },
  { key: 'flowType', label: 'Flow', dim: 'flowTypes' },
  { key: 'runner', label: 'Runner', dim: 'runners' },
  { key: 'model', label: 'Model', dim: 'models' },
] as const satisfies ReadonlyArray<{
  key: keyof AnalyticsQueryParams;
  label: string;
  dim: keyof AnalyticsQueryResult['dimensions'];
}>;

type DimKey = (typeof DIMENSIONS)[number]['key'];

const TIME_WINDOWS = [
  { token: '', label: 'All time' },
  { token: '24h', label: '24h', days: 1 },
  { token: '7d', label: '7d', days: 7 },
  { token: '30d', label: '30d', days: 30 },
] as const;

type WindowToken = (typeof TIME_WINDOWS)[number]['token'];

function windowToSince(token: WindowToken): string | undefined {
  const entry = TIME_WINDOWS.find((w) => w.token === token);
  if (!entry || !('days' in entry)) return undefined;
  return new Date(Date.now() - entry.days * 86_400_000).toISOString();
}

@customElement('analytics-panel')
export class AnalyticsPanel extends LitElement {
  /** Inject data for dev-harness / tests; when null the component fetches itself. */
  @property({ attribute: false }) injectedResult: AnalyticsQueryResult | null = null;

  @state() private result: AnalyticsQueryResult | null = null;
  @state() private filters: Partial<Record<DimKey, string>> = {};
  @state() private window: WindowToken = '';
  @state() private loading = false;
  @state() private backfilling = false;
  @state() private error = '';
  @state() private notice = '';
  private unsubscribeConnection?: () => void;
  private onHashChange = () => this.syncFromHash(true);

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      padding: ${unsafeCSS(spacing.lg)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      background: ${unsafeCSS(colors.bgBase)};
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.md)};
      flex-wrap: wrap;
    }
    h2 {
      margin: 0 0 ${unsafeCSS(spacing.xs)} 0;
      font-size: ${unsafeCSS(fonts.sizeLg)};
    }
    .subtitle {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      max-width: 760px;
    }
    button {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: 6px 10px;
      cursor: pointer;
    }
    button:hover {
      border-color: ${unsafeCSS(colors.accent)};
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: center;
    }
    /* Filter rows — one-click pills per dimension so switching selection is a single tap. */
    .filters {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: ${unsafeCSS(spacing.md)};
      padding-bottom: ${unsafeCSS(spacing.sm)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    .filter-row {
      display: grid;
      grid-template-columns: 64px 1fr;
      align-items: start;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .filter-row .dim-label {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      padding-top: 5px;
    }
    .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .pill {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 999px;
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 3px 11px;
      cursor: pointer;
      transition:
        background 0.1s,
        color 0.1s,
        border-color 0.1s;
    }
    .pill:hover {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .pill.active {
      background: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.bgBase)};
      font-weight: 600;
    }
    .error {
      border: 1px solid ${unsafeCSS(colors.statusFail)};
      border-radius: 8px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.statusFail)};
      background: ${unsafeCSS(colors.statusFail)}14;
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .notice {
      border: 1px solid ${unsafeCSS(colors.accent)};
      border-radius: 8px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}14;
      margin-bottom: ${unsafeCSS(spacing.md)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .empty {
      border: 1px dashed ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      color: ${unsafeCSS(colors.textMuted)};
      padding: ${unsafeCSS(spacing.lg)};
      text-align: center;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: ${unsafeCSS(spacing.md)};
      transition: opacity 0.12s;
    }
    .grid.reloading {
      opacity: 0.55;
    }
    .card {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      background: ${unsafeCSS(colors.bgSurface)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .card h3 {
      margin: 0 0 ${unsafeCSS(spacing.sm)} 0;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 96px 1fr auto;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      margin-bottom: 6px;
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .bar-track {
      position: relative;
      height: 14px;
      background: ${unsafeCSS(colors.bgBase)};
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: ${unsafeCSS(colors.accent)};
      opacity: 0.55;
      border-radius: 4px;
    }
    .bar-fill.p90 {
      opacity: 0.25;
    }
    .bar-label {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .bar-stat {
      color: ${unsafeCSS(colors.textMuted)};
      white-space: nowrap;
    }
    .kv {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      display: inline-flex;
      gap: 6px;
      padding: 3px 8px;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 999px;
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .chip .v {
      color: ${unsafeCSS(colors.accent)};
      font-weight: 600;
    }
    .chip.fail .v {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .stat-line {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (this.injectedResult) {
      this.result = this.injectedResult;
      return;
    }
    this.syncFromHash(false);
    window.addEventListener('hashchange', this.onHashChange);
    this.unsubscribeConnection = gateway.onConnectionChange((s) => {
      if (s === 'connected') void this.load();
    });
    if (gateway.connectionState === 'connected') void this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.onHashChange);
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = undefined;
  }

  /** Read filters + time window from the URL hash so selections are shareable + back/forward works. */
  private syncFromHash(reload: boolean) {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute(location.hash);
    if (!route.startsWith('analytics')) return;
    const next: Partial<Record<DimKey, string>> = {};
    for (const d of DIMENSIONS) {
      const v = params.get(d.key);
      if (v) next[d.key] = v;
    }
    this.filters = next;
    this.window = (params.get('window') as WindowToken) ?? '';
    if (reload && gateway.connectionState === 'connected') void this.load();
  }

  private writeHash() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute(location.hash);
    if (!route.startsWith('analytics')) return;
    for (const d of DIMENSIONS) {
      const v = this.filters[d.key];
      if (v) params.set(d.key, v);
      else params.delete(d.key);
    }
    if (this.window) params.set('window', this.window);
    else params.delete('window');
    const nextHash = buildHash(route, params);
    if (location.hash !== nextHash) history.replaceState(null, '', nextHash);
  }

  async load() {
    this.loading = true;
    try {
      const query: AnalyticsQueryParams = { ...(this.filters as AnalyticsQueryParams) };
      const since = windowToSince(this.window);
      if (since) query.since = since;
      this.result = await gateway.request<AnalyticsQueryResult>(Methods.ANALYTICS_QUERY, query);
      this.error = '';
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private async runBackfill() {
    this.backfilling = true;
    this.notice = '';
    try {
      const res = await gateway.request<{ scanned: number; written: number; skipped: number }>(
        Methods.ANALYTICS_BACKFILL,
      );
      this.notice = `Backfill complete — wrote ${res.written}, skipped ${res.skipped} of ${res.scanned} terminal runs.`;
      await this.load();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.backfilling = false;
    }
  }

  /** Toggle a dimension filter: clicking the active value (or "All") clears it. */
  private toggleFilter(key: DimKey, value: string) {
    const next = { ...this.filters };
    if (!value || next[key] === value) delete next[key];
    else next[key] = value;
    this.filters = next;
    this.writeHash();
    void this.load();
  }

  private setWindow(token: WindowToken) {
    this.window = token;
    this.writeHash();
    void this.load();
  }

  private clearAll() {
    this.filters = {};
    this.window = '';
    this.writeHash();
    void this.load();
  }

  private get hasActiveFilters(): boolean {
    return Object.keys(this.filters).length > 0 || this.window !== '';
  }

  private renderFilters(r: AnalyticsQueryResult) {
    return html`
      <div class="filters">
        ${DIMENSIONS.map((d) => {
          const options = r.dimensions[d.dim];
          if (options.length === 0) return nothing;
          const active = this.filters[d.key];
          return html`
            <div class="filter-row">
              <span class="dim-label">${d.label}</span>
              <div class="pills">
                <button
                  class="pill ${active ? '' : 'active'}"
                  @click=${() => this.toggleFilter(d.key, '')}
                >
                  All
                </button>
                ${options.map(
                  (o) => html`
                    <button
                      class="pill ${active === o ? 'active' : ''}"
                      @click=${() => this.toggleFilter(d.key, o)}
                    >
                      ${o}
                    </button>
                  `,
                )}
              </div>
            </div>
          `;
        })}
        <div class="filter-row">
          <span class="dim-label">Window</span>
          <div class="pills">
            ${TIME_WINDOWS.map(
              (w) => html`
                <button
                  class="pill ${this.window === w.token ? 'active' : ''}"
                  @click=${() => this.setWindow(w.token)}
                >
                  ${w.label}
                </button>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  private renderBars(title: string, entries: Array<{ label: string; stats: DurationStats }>) {
    const max = entries.reduce((m, e) => Math.max(m, e.stats.p90 ?? e.stats.p50 ?? 0), 1);
    return html`
      <div class="card">
        <h3>${title}</h3>
        ${entries.map((e) => {
          const p50 = e.stats.p50 ?? 0;
          const p90 = e.stats.p90 ?? p50;
          return html`
            <div class="bar-row">
              <span class="bar-label">${e.label}</span>
              <div class="bar-track">
                <div class="bar-fill p90" style="width:${(p90 / max) * 100}%"></div>
                <div class="bar-fill" style="width:${(p50 / max) * 100}%"></div>
              </div>
              <span class="bar-stat"
                >${fmtMs(e.stats.p50)} / ${fmtMs(e.stats.p90)} / ${fmtMs(e.stats.max)} ·
                n=${e.stats.n}</span
              >
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderCounts(title: string, counts: Record<string, number>, fail = false) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return html`
      <div class="card">
        <h3>${title}</h3>
        ${entries.length === 0
          ? html`<span class="muted">none</span>`
          : html`<div class="kv">
              ${entries.map(
                ([k, v]) =>
                  html`<span class="chip ${fail ? 'fail' : ''}"
                    >${k}<span class="v">${v}</span></span
                  >`,
              )}
            </div>`}
      </div>
    `;
  }

  render() {
    const r = this.result;
    return html`
      <div class="header">
        <div>
          <h2>Pipeline Analytics</h2>
          <div class="subtitle">
            Per-step bottlenecks, failure attribution, loop counts, and wait time across terminal
            runs. Cost/tokens are intentionally excluded until per-runner extraction is reliable.
          </div>
        </div>
        <div class="toolbar">
          ${this.hasActiveFilters
            ? html`<button @click=${() => this.clearAll()}>Clear filters</button>`
            : nothing}
          <button @click=${() => this.load()} ?disabled=${this.loading}>
            ${this.loading ? 'Loading…' : 'Refresh'}
          </button>
          <button @click=${() => this.runBackfill()} ?disabled=${this.backfilling}>
            ${this.backfilling ? 'Backfilling…' : 'Backfill from runs'}
          </button>
        </div>
      </div>

      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${this.notice ? html`<div class="notice">${this.notice}</div>` : nothing}
      ${!r
        ? html`<div class="empty">
            ${this.loading ? 'Loading analytics…' : 'No analytics yet.'}
          </div>`
        : html`
            ${this.renderFilters(r)}
            <div class="stat-line">
              <strong>${r.matchedRuns}</strong> / ${r.scannedRuns} runs ·
              <span class="muted">status</span> ${Object.entries(r.byStatus)
                .map(([k, v]) => `${k}=${v}`)
                .join('  ')}${r.parseFailures > 0
                ? html` · <span class="muted">${r.parseFailures} unreadable</span>`
                : nothing}
            </div>
            ${r.matchedRuns === 0
              ? html`<div class="empty">
                  No runs match these filters.
                  ${this.hasActiveFilters
                    ? 'Clear filters to widen the view.'
                    : 'Try "Backfill from runs" to seed the sink from current runs.'}
                </div>`
              : html`
                  <div class="grid ${this.loading ? 'reloading' : ''}">
                    ${this.renderBars(
                      'Step bottlenecks (p50 / p90 / max)',
                      r.bottleneck.map((b) => ({ label: b.step, stats: b.stats })),
                    )}
                    ${this.renderBars('Wall vs idle (waiting)', [
                      { label: 'wall', stats: r.wall },
                      { label: 'idle', stats: r.idle },
                    ])}
                    ${this.renderCounts('Failures by step', r.failureByStep, true)}
                    ${this.renderCounts('Failures by reason', r.failureByReason, true)}
                    ${this.renderCounts('CI results', r.ci.resultBreakdown)}
                    ${this.renderCounts('Self-review loops', r.selfReviewLoops.distribution)}
                    ${this.renderCounts('Runs by model', r.byModel)}
                    ${this.renderCounts('Runs by runner', r.byRunner)}
                    ${this.renderCounts('Runs by template', r.byTemplate)}
                    <div class="card">
                      <h3>Nudges (human babysitting)</h3>
                      <div class="stat-line">
                        avg <span class="muted">${r.nudges.avg}</span> · zero-nudge
                        <span class="muted">${Math.round(r.nudges.zeroRate * 100)}%</span>
                      </div>
                      <div class="kv">
                        ${Object.entries(r.nudges.byModel)
                          .sort((a, b) => b[1] - a[1])
                          .map(
                            ([k, v]) =>
                              html`<span class="chip">${k}<span class="v">${v}</span></span>`,
                          )}
                      </div>
                    </div>
                  </div>
                `}
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'analytics-panel': AnalyticsPanel;
  }
}
