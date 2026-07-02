import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  type IntelligenceAction,
  type IntelligenceActionsSummary,
  Methods,
  type MonitorViolation,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

import { actionToHuman, categoryToTrigger } from './intelligence-incident-copy.js';

function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : '-';
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return iso;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function formatExactTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

type IncidentStatus = 'recovered' | 'failed' | 'in-flight' | 'skipped' | 'human';

function deriveStatus(record: IntelligenceAction): IncidentStatus {
  if (record.followupOutcome === 'recovered') return 'recovered';
  if (record.followupOutcome === 'failed-again') return 'failed';
  if (record.followupOutcome === 'human-overrode') return 'human';
  if (record.followupOutcome === 'cancelled') return 'failed';
  if (record.outcome === 'errored') return 'failed';
  if (record.outcome === 'skipped') return 'skipped';
  if (record.outcome === 'applied' && !record.followupOutcome) return 'in-flight';
  return 'in-flight';
}

function statusBadge(status: IncidentStatus): { label: string; color: string } {
  switch (status) {
    case 'recovered':
      return { label: 'RECOVERED', color: colors.statusOk };
    case 'failed':
      return { label: 'FAILED', color: colors.statusFail };
    case 'in-flight':
      return { label: 'IN FLIGHT', color: colors.statusWarn };
    case 'skipped':
      return { label: 'SKIPPED', color: colors.textMuted };
    case 'human':
      return { label: 'HUMAN OVERRODE', color: colors.accent };
  }
}

function outcomeNarrative(record: IntelligenceAction): string {
  const fu = record.followupOutcome;
  if (fu === 'recovered') return 'Worker resumed normally after recovery action.';
  if (fu === 'failed-again') return 'Recovery did not unblock the run; same failure resurfaced.';
  if (fu === 'human-overrode') return 'Operator intervened before automatic outcome was confirmed.';
  if (fu === 'cancelled') return 'Recovery flow was cancelled before completion.';
  if (record.outcome === 'applied') return 'Action applied; waiting for follow-up signal.';
  if (record.outcome === 'errored') return record.outcomeReason ?? 'Action failed to execute.';
  if (record.outcome === 'skipped')
    return record.outcomeReason ?? 'No matching policy / guards rejected action.';
  if (record.outcome === 'proposed') return 'Awaiting confirmation before action runs.';
  return record.outcome;
}

@customElement('intelligence-incidents-panel')
export class IntelligenceIncidentsPanel extends LitElement {
  /** Inject data for dev-harness / tests; when null component fetches itself. */
  @property({ attribute: false }) injectedSummary: IntelligenceActionsSummary | null = null;
  @property({ attribute: false }) injectedSignals: MonitorViolation[] | null = null;

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
      max-width: 760px;
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
    .live-strip {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.sm)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border: 1px solid ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}10;
      border-radius: 8px;
      margin-bottom: ${unsafeCSS(spacing.md)};
      align-items: center;
    }
    .live-label {
      font-weight: 700;
      color: ${unsafeCSS(colors.statusWarn)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .live-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border: 1px solid ${unsafeCSS(colors.statusWarn)}55;
      border-radius: 999px;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      background: ${unsafeCSS(colors.bgSurface)};
      text-decoration: none;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .live-chip:hover {
      border-color: ${unsafeCSS(colors.statusWarn)};
    }
    .live-chip .type {
      color: ${unsafeCSS(colors.statusWarn)};
      font-weight: 600;
    }
    .empty {
      border: 1px dashed ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      color: ${unsafeCSS(colors.textMuted)};
      padding: ${unsafeCSS(spacing.lg)};
      text-align: center;
    }
    .error {
      border: 1px solid ${unsafeCSS(colors.statusFail)};
      border-radius: 8px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.statusFail)};
      background: ${unsafeCSS(colors.statusFail)}14;
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .warning {
      border: 1px solid ${unsafeCSS(colors.statusWarn)};
      border-radius: 8px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}14;
      margin-bottom: ${unsafeCSS(spacing.md)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .incidents {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .incident {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-left: 3px solid var(--status-color, ${unsafeCSS(colors.textMuted)});
      border-radius: 8px;
      background: ${unsafeCSS(colors.bgSurface)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .incident-head {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      flex-wrap: wrap;
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .slot-pill {
      font-weight: 700;
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
      font-size: ${unsafeCSS(fonts.sizeMd)};
    }
    .slot-pill:hover {
      text-decoration: underline;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: var(--status-color, ${unsafeCSS(colors.textMuted)});
      border: 1px solid var(--status-color, ${unsafeCSS(colors.textMuted)});
      background: color-mix(
        in srgb,
        var(--status-color, ${unsafeCSS(colors.textMuted)}) 12%,
        transparent
      );
    }
    .time {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      margin-left: auto;
    }
    .narrative {
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: ${unsafeCSS(spacing.md)};
      row-gap: 6px;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.5;
    }
    .narrative dt {
      color: ${unsafeCSS(colors.textMuted)};
      font-weight: 600;
      margin: 0;
    }
    .narrative dd {
      margin: 0;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .narrative code {
      background: ${unsafeCSS(colors.bgCard)};
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 12px;
    }
    .links {
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
      margin-top: ${unsafeCSS(spacing.sm)};
      padding-top: ${unsafeCSS(spacing.sm)};
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    .link {
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .link:hover {
      text-decoration: underline;
    }
    .meta-foot {
      margin-top: ${unsafeCSS(spacing.lg)};
      padding-top: ${unsafeCSS(spacing.sm)};
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.md)};
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (this.injectedSummary || this.injectedSignals) {
      this.summary = this.injectedSummary;
      this.monitorSignals = this.injectedSignals ?? [];
      return;
    }
    this.unsubscribeConnection = gateway.onConnectionChange((s) => {
      if (s === 'connected') void this.load();
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

  private renderLiveStrip() {
    if (this.monitorSignals.length === 0) return nothing;
    return html`
      <div class="live-strip">
        <span class="live-label">LIVE</span>
        ${this.monitorSignals.map(
          (s) => html`
            <a class="live-chip" href=${`#slot/${s.slotId}`} title=${s.message}>
              <span class="type">${s.type}</span>
              <span>${s.slotId}</span>
              <span style="color:${colors.textMuted}">${formatRelativeTime(s.timestamp)}</span>
            </a>
          `,
        )}
      </div>
    `;
  }

  private renderIncident(record: IntelligenceAction) {
    const status = deriveStatus(record);
    const badge = statusBadge(status);
    const slotId = this.slotIdForRecord(record);
    const duration =
      status === 'recovered' || status === 'failed'
        ? formatDuration(record.decidedAt, record.timestamp)
        : '';
    return html`
      <article class="incident" style=${`--status-color:${badge.color}`}>
        <div class="incident-head">
          ${slotId
            ? html`<a class="slot-pill" href=${`#slot/${slotId}`}>${slotId}</a>`
            : html`<span class="slot-pill">${record.project ?? 'unknown'}</span>`}
          <span class="status-badge">${badge.label}</span>
          ${record.stepName ? html`<code>${record.stepName}</code>` : nothing}
          <span class="time" title=${record.decidedAt}>
            ${formatExactTime(record.decidedAt)} · ${formatRelativeTime(record.decidedAt)}
            ${duration ? html` · took ${duration}` : nothing}
          </span>
        </div>
        <dl class="narrative">
          <dt>What gateway saw</dt>
          <dd>${categoryToTrigger(record)}</dd>
          <dt>What gateway did</dt>
          <dd>${actionToHuman(record)}</dd>
          <dt>Outcome</dt>
          <dd>${outcomeNarrative(record)}</dd>
        </dl>
        <div class="links">
          <a class="link" href=${`#run/${record.runId}`}>→ Open run ${shortId(record.runId)}</a>
          ${slotId
            ? html`<a class="link" href=${`#slot/${slotId}`}>→ Open slot terminal</a>`
            : nothing}
          ${record.familyId
            ? html`<a class="link" href=${`#family/${record.familyId}`}
                >→ Family ${shortId(record.familyId)}</a
              >`
            : nothing}
        </div>
      </article>
    `;
  }

  /** Best-effort: live monitor signal closest in time to this record. */
  private slotIdForRecord(record: IntelligenceAction): string | undefined {
    const decidedAt = new Date(record.decidedAt).getTime();
    let best: { slotId: string; delta: number } | undefined;
    for (const sig of this.monitorSignals) {
      const t = new Date(sig.timestamp).getTime();
      const delta = Math.abs(t - decidedAt);
      if (delta > 5 * 60 * 1000) continue;
      if (!best || delta < best.delta) best = { slotId: sig.slotId, delta };
    }
    return best?.slotId;
  }

  private renderFooter(summary: IntelligenceActionsSummary) {
    const applied = summary.byOutcome.applied ?? 0;
    const errored = summary.byOutcome.errored ?? 0;
    const skipped = summary.byOutcome.skipped ?? 0;
    return html`
      <footer class="meta-foot">
        <span>${summary.total} records</span>
        <span>${applied} applied</span>
        <span>${errored} errored</span>
        <span>${skipped} skipped</span>
        <span>${summary.metadata.parseFailures} parse failures</span>
        <span>${summary.metadata.shapeDriftFailures} schema drift</span>
      </footer>
    `;
  }

  render() {
    const summary = this.summary;
    const hasDrift =
      !!summary && (summary.metadata.parseFailures > 0 || summary.metadata.shapeDriftFailures > 0);
    return html`
      <div class="header">
        <div>
          <h2>Recovery incidents</h2>
          <div class="subtitle">
            What the gateway saw, what it tried, and whether the run recovered. Newest first.
            Sourced from
            <code>~/.farmslot/logs/intelligence-actions/*.ndjson</code> plus live monitor signals.
          </div>
        </div>
        <button
          ?disabled=${this.loading || (!!this.injectedSummary && this.injectedSummary !== null)}
          @click=${() => this.load()}
        >
          ${this.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${hasDrift
        ? html`<div class="warning">
            Some audit lines could not be parsed against the current schema. Counts in the footer
            separate raw JSON failures from shape drift.
          </div>`
        : nothing}
      ${this.renderLiveStrip()}
      ${summary === null
        ? html`<div class="empty">
            ${gateway.connectionState === 'connected'
              ? 'Loading incidents…'
              : 'Waiting for gateway connection…'}
          </div>`
        : summary.records.length === 0
          ? html`<div class="empty">
              No recovery incidents yet. When the gateway detects a stuck/idle/errored run and
              applies a recovery action, it lands here.
            </div>`
          : html`<div class="incidents">
              ${summary.records.map((r) => this.renderIncident(r))}
            </div>`}
      ${summary ? this.renderFooter(summary) : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'intelligence-incidents-panel': IntelligenceIncidentsPanel;
  }
}
