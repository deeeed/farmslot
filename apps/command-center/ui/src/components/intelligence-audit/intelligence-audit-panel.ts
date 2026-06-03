import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  type IntelligenceAction,
  type IntelligenceActionsSummary,
  Methods,
  type MonitorViolation,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : '-';
}

function formatDate(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return iso;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return formatDate(iso);
}

function statusColor(value: string): string {
  if (value === 'recovered') return colors.accentHover;
  if (value === 'applied' || value === 'proposed') return colors.textSecondary;
  if (value === 'errored' || value === 'failed-again') return colors.statusFail;
  if (value === 'skipped') return colors.statusWarn;
  return colors.textMuted;
}

function monitorSignalColor(type: MonitorViolation['type']): string {
  if (type === 'error' || type === 'stuck') return colors.statusFail;
  if (type === 'idle' || type === 'waiting') return colors.textSecondary;
  return colors.textMuted;
}

@customElement('intelligence-audit-panel')
export class IntelligenceAuditPanel extends LitElement {
  @state() private summary: IntelligenceActionsSummary | null = null;
  @state() private monitorSignals: MonitorViolation[] = [];
  @state() private error = '';
  @state() private loading = false;
  private unsubscribeConnection?: () => void;
  private unsubscribeState?: () => void;

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
    }
    h2 {
      margin: 0 0 ${unsafeCSS(spacing.xs)} 0;
      font-size: ${unsafeCSS(fonts.sizeLg)};
    }
    .subtitle {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.5;
      max-width: 900px;
    }
    button {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      padding: 7px 10px;
      cursor: pointer;
    }
    button:hover {
      border-color: ${unsafeCSS(colors.accent)};
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: ${unsafeCSS(spacing.sm)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .stat {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      background: ${unsafeCSS(colors.bgSurface)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .stat-value {
      display: block;
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 4px;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .stat-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .warning {
      border: 1px solid ${unsafeCSS(colors.statusWarn)};
      border-radius: 8px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}14;
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .error {
      border: 1px solid ${unsafeCSS(colors.statusFail)};
      border-radius: 8px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.statusFail)};
      background: ${unsafeCSS(colors.statusFail)}14;
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .empty {
      border: 1px dashed ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      color: ${unsafeCSS(colors.textMuted)};
      padding: ${unsafeCSS(spacing.lg)};
      text-align: center;
    }
    .records {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .section {
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      margin: ${unsafeCSS(spacing.md)} 0 ${unsafeCSS(spacing.sm)};
    }
    .section-title h3 {
      margin: 0;
      font-size: ${unsafeCSS(fonts.sizeMd)};
    }
    .section-note {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .signals {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: ${unsafeCSS(spacing.sm)};
    }
    .signal {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      background: ${unsafeCSS(colors.bgSurface)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .signal-top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .slot-link {
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
      font-weight: 700;
    }
    .slot-link:hover {
      text-decoration: underline;
    }
    .signal-message {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.4;
      margin-bottom: 8px;
    }
    .record {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      background: ${unsafeCSS(colors.bgSurface)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .record-top {
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .record-title {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .run-link {
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
      font-weight: 700;
    }
    .run-link:hover {
      text-decoration: underline;
    }
    .time {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      white-space: nowrap;
    }
    .badge {
      border: 1px solid
        color-mix(in srgb, var(--badge-color, ${unsafeCSS(colors.textMuted)}) 55%, transparent);
      color: var(--badge-color, ${unsafeCSS(colors.textMuted)});
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      line-height: 1.4;
      background: color-mix(
        in srgb,
        var(--badge-color, ${unsafeCSS(colors.textMuted)}) 7%,
        transparent
      );
      font-weight: 500;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px 14px;
      margin-top: ${unsafeCSS(spacing.sm)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .field-label {
      display: block;
      color: ${unsafeCSS(colors.textMuted)};
      margin-bottom: 2px;
    }
    .guards {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: ${unsafeCSS(spacing.sm)};
    }
    .guard-pass {
      --badge-color: ${unsafeCSS(colors.textMuted)};
      opacity: 0.82;
    }
    .guard-fail {
      --badge-color: ${unsafeCSS(colors.statusWarn)};
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribeConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected') void this.load();
    });
    this.syncState(getState());
    this.unsubscribeState = subscribe((s) => this.syncState(s));
    if (gateway.connectionState === 'connected') void this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = undefined;
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
  }

  private syncState(s: AppState): void {
    this.monitorSignals = s.violations.slice(0, 12);
  }

  async load() {
    this.loading = true;
    try {
      const res = await gateway.request<{ summary: IntelligenceActionsSummary }>(
        Methods.INTELLIGENCE_ACTIONS_SUMMARY,
        { limit: 100 },
      );
      this.summary = res.summary;
      this.error = '';
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private renderStats(summary: IntelligenceActionsSummary) {
    const applied = summary.byOutcome.applied ?? 0;
    const skipped = summary.byOutcome.skipped ?? 0;
    const errored = summary.byOutcome.errored ?? 0;
    return html`
      <div class="stats">
        <div class="stat">
          <span class="stat-value">${summary.total}</span
          ><span class="stat-label">valid audit records</span>
        </div>
        <div class="stat">
          <span class="stat-value">${applied}</span><span class="stat-label">actions applied</span>
        </div>
        <div class="stat">
          <span class="stat-value">${skipped}</span><span class="stat-label">actions skipped</span>
        </div>
        <div class="stat">
          <span class="stat-value">${errored}</span><span class="stat-label">actions errored</span>
        </div>
        <div class="stat">
          <span class="stat-value">${summary.metadata.parseFailures}</span
          ><span class="stat-label">JSON parse failures</span>
        </div>
        <div class="stat">
          <span class="stat-value">${summary.metadata.shapeDriftFailures}</span
          ><span class="stat-label">schema drift failures</span>
        </div>
        <div class="stat">
          <span class="stat-value">${this.monitorSignals.length}</span
          ><span class="stat-label">live monitor signals</span>
        </div>
      </div>
    `;
  }

  private renderMonitorSignals() {
    return html`
      <section class="section">
        <div class="section-title">
          <h3>Live monitor signals</h3>
          <span class="section-note"
            >Former “Violations” feed — now treated as gateway intelligence inputs.</span
          >
        </div>
        ${this.monitorSignals.length === 0
          ? html`<div class="empty">
              No live monitor signals. Stale/idle worker detections will appear here and in audit
              records when gateway intelligence evaluates them.
            </div>`
          : html`
              <div class="signals">
                ${this.monitorSignals.map(
                  (signal) => html`
                    <article class="signal">
                      <div class="signal-top">
                        <a class="slot-link" href=${`#slot/${signal.slotId}`}>${signal.slotId}</a>
                        <span
                          class="badge"
                          style=${`--badge-color:${monitorSignalColor(signal.type)}`}
                          >${signal.type}</span
                        >
                        <span class="time" title=${signal.timestamp}
                          >${formatRelativeTime(signal.timestamp)}</span
                        >
                      </div>
                      <div class="signal-message">${signal.message}</div>
                      <div class="section-note">
                        ${signal.nudgeSent
                          ? `nudge sent ${formatRelativeTime(signal.nudgeSent)}`
                          : 'awaiting gateway/operator action'}
                      </div>
                    </article>
                  `,
                )}
              </div>
            `}
      </section>
    `;
  }

  private renderRecord(record: IntelligenceAction) {
    const outcomeColor = statusColor(record.followupOutcome ?? record.outcome);
    return html`
      <article class="record">
        <div class="record-top">
          <div class="record-title">
            <a class="run-link" href=${`#run/${record.runId}`}>${shortId(record.runId)}</a>
            ${record.stepName ? html`<span>${record.stepName}</span>` : nothing}
            <span class="badge" style=${`--badge-color:${outcomeColor}`}>${record.outcome}</span>
            ${record.outcomeReason
              ? html`<span class="badge" style=${`--badge-color:${colors.statusWarn}`}
                  >${record.outcomeReason}</span
                >`
              : nothing}
            ${record.followupOutcome
              ? html`<span
                  class="badge"
                  style=${`--badge-color:${statusColor(record.followupOutcome)}`}
                  >follow-up: ${record.followupOutcome}</span
                >`
              : nothing}
          </div>
          <span class="time" title=${record.decidedAt}>${formatDate(record.decidedAt)}</span>
        </div>
        <div class="grid">
          <div><span class="field-label">Actor / tier</span>${record.actor} / ${record.tier}</div>
          <div>
            <span class="field-label">Policy bucket</span>${record.verdict.category ??
            'uncategorized'}
            ·
            ${record.verdict.confidence}${record.verdict.patternId
              ? ` · ${record.verdict.patternId}`
              : ''}
          </div>
          <div>
            <span class="field-label"
              >${record.outcome === 'applied' ? 'Applied action' : 'Recommended action'}</span
            >${record.appliedAction?.type ?? 'none'}${record.appliedAction?.stepName
              ? ` · ${record.appliedAction.stepName}`
              : ''}
          </div>
          <div>
            <span class="field-label">Project / family</span>${record.project ?? '-'} /
            ${shortId(record.familyId)}
          </div>
          <div>
            <span class="field-label">Decision input timestamp</span>${formatDate(record.timestamp)}
          </div>
          <div>
            <span class="field-label">Latency / cost</span>${record.latencyMs ?? '-'}ms /
            $${record.costUsd.toFixed(4)}
          </div>
        </div>
        ${record.guards.length
          ? html`
              <div class="guards">
                ${record.guards.map(
                  (guard) =>
                    html`<span class="badge ${guard.passed ? 'guard-pass' : 'guard-fail'}"
                      >${guard.passed ? 'pass' : 'fail'}:${guard.name}</span
                    >`,
                )}
              </div>
            `
          : nothing}
      </article>
    `;
  }

  render() {
    const summary = this.summary;
    const hasDrift =
      !!summary && (summary.metadata.parseFailures > 0 || summary.metadata.shapeDriftFailures > 0);
    return html`
      <div class="header">
        <div>
          <h2>Gateway Intelligence</h2>
          <div class="subtitle">
            Unified view of live monitor signals plus append-only auto-recovery decisions from
            <code>~/.farmslot/logs/intelligence-actions/*.ndjson</code>. Provider/model/auth are
            gateway-wide; auto-recovery authority, allowlists, and spend caps are granted per
            project. This is evidence/provenance: which seed policy bucket/pattern matched, which
            guards passed, what action was attempted, and whether audit parsing degraded.
          </div>
        </div>
        <button ?disabled=${this.loading} @click=${() => this.load()}>
          ${this.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${hasDrift
        ? html`<div class="warning">
            Some audit lines could not be parsed or no longer match the typed schema. The counters
            below separate raw JSON failures from shape drift.
          </div>`
        : nothing}
      ${this.renderMonitorSignals()}
      ${summary
        ? this.renderStats(summary)
        : html`<div class="empty">
            ${gateway.connectionState === 'connected'
              ? 'Loading audit records…'
              : 'Waiting for gateway connection…'}
          </div>`}
      ${summary && summary.records.length === 0
        ? html`<div class="empty">No intelligence actions have been recorded yet.</div>`
        : nothing}
      ${summary?.records.length
        ? html`<div class="records">
            ${summary.records.map((record) => this.renderRecord(record))}
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'intelligence-audit-panel': IntelligenceAuditPanel;
  }
}
