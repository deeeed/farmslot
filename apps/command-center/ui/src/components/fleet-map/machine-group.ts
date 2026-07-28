import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  MachineHealth,
  MachineProviderAccountsSnapshot,
  NodeInfo,
  ProviderRunnerAccountStatus,
  Run,
  SlotStatus,
  TaskProgressStructured,
} from '@farmslot/protocol';

import './slot-card.js';
import './machine-health-bar.js';
import '../runs/run-pipeline.js';

import { getProjectSlotTrackingConfigs } from '../../state.js';
import {
  colors,
  fonts,
  lifecycleColor,
  radii,
  shadows,
  spacing,
} from '../../styles/theme-tokens.js';
import { flowColor, flowLabel, formatElapsed, runStatusColor } from '../runs/run-utils.js';
import type { SlotPendingWork } from '../work-graph/work-graph-execution-overlay.js';

import { slotBranchDisplay } from './slot-branch-display.js';

@customElement('machine-group')
export class MachineGroup extends LitElement {
  @property() machine = '';
  @property({ type: Array }) slots: SlotStatus[] = [];
  @property({ attribute: false }) onlineMachines: Set<string> = new Set();
  @property({ attribute: false }) slotProgress: Map<string, TaskProgressStructured> = new Map();
  @property({ attribute: false }) slotRuns: Map<string, Run> = new Map();
  @property({ attribute: false }) machineHealth?: MachineHealth;
  @property({ attribute: false }) slotThumbnails: Map<string, { data: string; ts: number }> =
    new Map();
  @property({ attribute: false }) slotDecisions: Map<string, number> = new Map();
  @property({ attribute: false }) slotPendingWork: Map<string, SlotPendingWork> = new Map();
  @property({ attribute: false }) nodeInfo?: NodeInfo;
  @property({ attribute: false }) nodeInfoMap: Map<string, NodeInfo> = new Map();
  @property({ attribute: false }) machineHealthMap: Map<string, MachineHealth> = new Map();
  @property() gatewayProtocolVersion = '';
  @property() viewMode: 'card' | 'list' = 'card';
  /** Per-machine provider subscription seats (bind + CodexBar mirror). */
  @property({ attribute: false }) providerAccounts?: MachineProviderAccountsSnapshot;
  @state() private expandedSlotId: string | null = null;
  /** Accounts panel open (subscription matrix lives under a button, not header clutter). */
  @state() private accountsOpen = false;

  static styles = css`
    :host {
      display: block;
    }
    .group {
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.lg)};
      padding: ${unsafeCSS(spacing.lg)};
      box-shadow: ${unsafeCSS(shadows.card)};
    }
    .group-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.lg)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeMd)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }
    .machine-link {
      color: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .machine-link:hover {
      text-decoration: underline;
    }
    .os-icon {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
    }
    .slot-count {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
      margin-left: auto;
    }
    .node-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.3px;
      font-family: ${unsafeCSS(fonts.mono)};
      cursor: help;
    }
    .node-badge.offline {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.4);
    }
    .node-badge.stale {
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      border: 1px solid rgba(245, 158, 11, 0.4);
    }
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: ${unsafeCSS(spacing.lg)};
    }
    .run-panel {
      margin-top: ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.md)};
      animation: panel-slide 0.15s ease-out;
    }
    @keyframes panel-slide {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .run-panel-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.md)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .run-panel-id {
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }
    .run-panel-flow {
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .run-panel-ticket {
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .run-panel-status {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .run-panel-elapsed {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .run-panel-nav {
      margin-left: auto;
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .nav-btn {
      padding: 2px 8px;
      border-radius: 3px;
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      cursor: pointer;
    }
    .nav-btn:hover {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }
    /* ─── List View ─── */
    .slot-table {
      width: 100%;
      border-collapse: collapse;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .slot-table th {
      text-align: left;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      padding: 4px 8px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      font-weight: 400;
      white-space: nowrap;
    }
    .slot-row {
      cursor: pointer;
      transition: background 0.1s;
    }
    .slot-row:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .slot-row td {
      padding: 6px 8px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)}22;
      vertical-align: middle;
      white-space: nowrap;
    }
    .slot-row .lc-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .slot-row .slot-name {
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }
    .slot-row .flow-pill {
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .slot-row .summary-cell {
      color: ${unsafeCSS(colors.textSecondary)};
      max-width: 350px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .slot-row .progress-cell {
      min-width: 80px;
    }
    .slot-row .progress-bar {
      display: inline-block;
      width: 60px;
      height: 4px;
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: 2px;
      overflow: hidden;
      vertical-align: middle;
      margin-right: 4px;
    }
    .slot-row .progress-fill {
      height: 100%;
      background: ${unsafeCSS(colors.accent)};
      border-radius: 2px;
    }
    .slot-row.expanded {
      background: ${unsafeCSS(colors.accent)}08;
    }
    .slot-row.expanded td:first-child {
      border-left: 2px solid ${unsafeCSS(colors.accent)};
    }
    .slot-row.working {
      background: rgba(245, 158, 11, 0.05);
      animation: row-pulse 2.5s ease-in-out infinite;
    }
    @keyframes row-pulse {
      0%,
      100% {
        background: rgba(245, 158, 11, 0.05);
      }
      50% {
        background: rgba(245, 158, 11, 0.1);
      }
    }
    .slot-row.working td:first-child {
      border-left: 2px solid #f59e0b;
    }
    .lc-text {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 600;
    }
    .working-spinner {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #f59e0b;
      margin-left: 5px;
      vertical-align: middle;
      animation: dot-blink 1.2s ease-in-out infinite;
    }
    @keyframes dot-blink {
      0%,
      100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.35;
        transform: scale(0.65);
      }
    }
    .slot-row .muted {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .slot-row .branch-cell {
      color: ${unsafeCSS(colors.accent)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .slot-row .branch-cell.main,
    .slot-row .branch-cell.tracking {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .slot-row .branch-cell.stale {
      color: ${unsafeCSS(colors.accent)};
    }
    /* Quiet header control — detail lives in a modal, not on the fleet chrome. */
    .setup-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-left: ${unsafeCSS(spacing.sm)};
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.3px;
      cursor: pointer;
      line-height: 1.4;
      flex-shrink: 0;
    }
    .setup-btn:hover,
    .setup-btn.open {
      border-color: ${unsafeCSS(colors.bgCardHover)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .setup-btn .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: ${unsafeCSS(colors.statusOk)};
      flex-shrink: 0;
    }
    .setup-btn .dot.warn {
      background: ${unsafeCSS(colors.statusWarn)};
    }
    .setup-btn .dot.muted {
      background: ${unsafeCSS(colors.textMuted)};
    }
    .setup-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 12vh 16px 24px;
      background: rgba(0, 0, 0, 0.5);
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .setup-modal {
      width: min(420px, 100%);
      max-height: min(70vh, 560px);
      overflow: auto;
      border-radius: ${unsafeCSS(radii.lg)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      background: ${unsafeCSS(colors.bgSurface)};
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .setup-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      padding: 14px 16px 10px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    .setup-kicker {
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .setup-title {
      margin: 4px 0 0;
      font-size: 14px;
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .setup-close {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 11px;
      padding: 3px 8px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .setup-close:hover {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    .setup-body {
      padding: 8px 10px 12px;
    }
    .setup-section-label {
      padding: 6px 6px 4px;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .setup-row {
      display: grid;
      grid-template-columns: 64px 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 8px 8px;
      border-radius: ${unsafeCSS(radii.sm)};
    }
    .setup-row:hover {
      background: ${unsafeCSS(colors.bgCard)};
    }
    .setup-runner {
      font-weight: 600;
      font-size: 11px;
      color: ${unsafeCSS(colors.accent)};
    }
    .setup-identity {
      min-width: 0;
      font-size: 11px;
      color: ${unsafeCSS(colors.textPrimary)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .setup-identity.muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .setup-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      font-size: 10px;
      color: ${unsafeCSS(colors.textSecondary)};
      white-space: nowrap;
    }
    .setup-badge {
      display: inline-block;
      padding: 0 5px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      border: 1px solid transparent;
    }
    .setup-badge.bind {
      background: rgba(34, 197, 94, 0.12);
      color: #16a34a;
      border-color: rgba(34, 197, 94, 0.35);
    }
    .setup-badge.ambient {
      background: rgba(148, 163, 184, 0.12);
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .setup-badge.off {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .setup-badge.warn {
      background: rgba(245, 158, 11, 0.12);
      color: #f59e0b;
      border-color: rgba(245, 158, 11, 0.35);
    }
    .setup-foot {
      padding: 0 16px 14px;
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      line-height: 1.35;
    }
    .setup-foot a {
      color: ${unsafeCSS(colors.accent)};
      text-decoration: none;
    }
    .setup-foot a:hover {
      text-decoration: underline;
    }
  `;

  private getOsIcon(): string {
    if (!this.slots.length) return '?';
    const platform = this.slots[0].platform;
    return platform === 'ios' ? 'mac' : 'lnx';
  }

  private handleSlotExpand(slotId: string) {
    this.expandedSlotId = this.expandedSlotId === slotId ? null : slotId;
  }

  private get groupMachines(): string[] {
    return [...new Set(this.slots.map((s) => s.machine))];
  }

  private orderedRunners(): ProviderRunnerAccountStatus[] {
    const snap = this.providerAccounts;
    if (!snap?.runners?.length) return [];
    const order = ['codex', 'claude', 'grok', 'cursor'];
    return [...snap.runners].sort(
      (a, b) =>
        order.indexOf(a.runner) - order.indexOf(b.runner) || a.runner.localeCompare(b.runner),
    );
  }

  /** Sync light-DOM attrs for recipes without cluttering the header. */
  private syncProviderAccountAttrs() {
    const runners = this.orderedRunners();
    if (!runners.length) {
      this.removeAttribute('data-provider-chips');
      this.removeAttribute('data-provider-emails');
      this.removeAttribute('data-testid');
      return;
    }
    const chipSummary = runners.map((r) => this.providerRowPlainText(r)).join(' ');
    this.setAttribute('data-provider-chips', chipSummary);
    const emails = runners
      .map((r) => r.usage?.accountEmail)
      .filter((e): e is string => Boolean(e))
      .join(' ');
    if (emails) this.setAttribute('data-provider-emails', emails);
    else this.removeAttribute('data-provider-emails');
    this.setAttribute('data-testid', 'machine-provider-accounts');
  }

  private providerRowPlainText(r: ProviderRunnerAccountStatus): string {
    let base: string;
    if (r.status === 'unsupported' && !r.usage?.accountEmail) {
      base = `${r.runner}:—`;
    } else if (r.status === 'error' && !r.usage?.accountEmail) {
      base = `${r.runner}:err`;
    } else if (r.status === 'unknown') {
      base = `${r.runner}:?`;
    } else if (r.status === 'ambient' || r.activeLabel === 'ambient') {
      base = `${r.runner}:ambient`;
    } else {
      base = `${r.runner}:${r.activeLabel ?? '?'}`;
    }
    if (r.usage?.accountEmail) base += ` ${r.usage.accountEmail}`;
    if (r.usage?.remainingPercent != null) base += ` ${Math.round(r.usage.remainingPercent)}%`;
    if (r.cooling?.length) base += ' cool';
    return base;
  }

  private accountsSummaryDotClass(): string {
    const runners = this.orderedRunners();
    if (!runners.length) return 'muted';
    if (runners.some((r) => r.cooling?.length)) return 'warn';
    if (runners.some((r) => r.usage?.accountEmail || r.status === 'bound')) return '';
    return 'muted';
  }

  /** Compact header control — no fleet chrome dump of emails/quota. */
  private setupButtonLabel(): string {
    return 'Setup';
  }

  private closeSetup = () => {
    this.accountsOpen = false;
  };

  private renderProviderAccounts() {
    this.syncProviderAccountAttrs();
    const runners = this.orderedRunners();
    if (!runners.length) return nothing;

    return html`
      <button
        type="button"
        class="setup-btn ${this.accountsOpen ? 'open' : ''}"
        data-testid="machine-accounts-btn"
        title="Node setup — runner seats & subscription bind for ${this.machine}"
        @click=${(e: Event) => {
          e.stopPropagation();
          this.accountsOpen = !this.accountsOpen;
        }}
      >
        <span class="dot ${this.accountsSummaryDotClass()}"></span>
        ${this.setupButtonLabel()}
      </button>
      ${this.accountsOpen ? this.renderSetupModal(runners) : nothing}
    `;
  }

  private renderSetupModal(runners: ProviderRunnerAccountStatus[]) {
    return html`
      <div
        class="setup-backdrop"
        data-testid="machine-accounts-panel"
        role="presentation"
        @click=${(e: Event) => {
          e.stopPropagation();
          this.closeSetup();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Escape') this.closeSetup();
        }}
      >
        <section
          class="setup-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Node setup for ${this.machine}"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <header class="setup-head">
            <div>
              <div class="setup-kicker">Node setup</div>
              <h2 class="setup-title">${this.machine}</h2>
            </div>
            <button type="button" class="setup-close" @click=${this.closeSetup}>Close</button>
          </header>
          <div class="setup-body">
            <div class="setup-section-label">Runner seats</div>
            ${runners.map((r) => this.renderSetupRow(r))}
          </div>
          <div class="setup-foot">
            Bind labels are farmslot-owned; identity &amp; quota mirror CodexBar when available.
            <a href="#config/${this.machine}">Machine config →</a>
          </div>
        </section>
      </div>
    `;
  }

  private renderSetupRow(r: ProviderRunnerAccountStatus) {
    const email = r.usage?.accountEmail?.trim() || null;
    const label = r.activeLabel && r.activeLabel !== 'ambient' ? r.activeLabel : null;
    const identity = email ?? label ?? null;
    const identityTitle = [
      email,
      label ? `label: ${label}` : null,
      r.usage?.loginMethod,
      r.usage?.error,
    ]
      .filter(Boolean)
      .join(' · ');

    const quota =
      r.usage?.remainingPercent != null
        ? `${Math.round(r.usage.remainingPercent)}%`
        : r.usage?.usedPercent != null
          ? `${Math.round(r.usage.usedPercent)}% used`
          : null;

    const cooling = Boolean(r.cooling?.length);
    let badgeClass = 'off';
    let badgeText = '—';
    if (cooling) {
      badgeClass = 'warn';
      badgeText = 'cool';
    } else if (r.status === 'bound') {
      badgeClass = 'bind';
      badgeText = 'bind';
    } else if (r.status === 'ambient' || email) {
      badgeClass = 'ambient';
      badgeText = 'ambient';
    } else if (r.status === 'error' || r.usage?.error) {
      badgeClass = 'off';
      badgeText = 'n/a';
    }

    return html`
      <div class="setup-row" data-runner=${r.runner}>
        <span class="setup-runner">${r.runner}</span>
        <span
          class="setup-identity ${identity ? '' : 'muted'}"
          title=${identityTitle || (r.usage?.error ? r.usage.error : '')}
        >
          ${identity ?? (r.usage?.error ? 'unavailable' : '—')}
        </span>
        <span class="setup-meta">
          ${quota ? html`<span>${quota}</span>` : nothing}
          <span class="setup-badge ${badgeClass}">${badgeText}</span>
        </span>
      </div>
    `;
  }

  private renderNodeBadge() {
    const machines = this.groupMachines;
    const offlineMachines = machines.filter((m) => !this.onlineMachines.has(m));
    const onlineMachines = machines.filter((m) => this.onlineMachines.has(m));

    // Check version mismatches on online machines
    for (const m of onlineMachines) {
      const info = this.nodeInfo ?? this.nodeInfoMap.get(m);
      if (
        info &&
        info.versionMatch === false &&
        info.protocolVersion &&
        this.gatewayProtocolVersion
      ) {
        const deployHint = `bash scripts/deploy-node.sh ${m}`;
        const title = `Node protocol v${info.protocolVersion} does not match gateway v${this.gatewayProtocolVersion}.\nUpdate:\n${deployHint}`;
        return html`<span class="node-badge stale" title="${title}"
          >NODE v${info.protocolVersion} ≠ v${this.gatewayProtocolVersion}</span
        >`;
      }
    }

    if (offlineMachines.length === 0) return nothing;

    // A machine with no connected node is DEGRADED, not down: its slots still run
    // (local execution goes through the gateway), but there is no live device feed /
    // file-watch / metrics until a node connects. Local host: `farmslot up` co-launches
    // it. Remote: deploy-node.sh.
    const fixHint =
      'Slots still run; live device feed / file-watch / metrics are unavailable until a node connects.\nLocal host: restart `farmslot up`.\nRemote:';

    if (offlineMachines.length === machines.length) {
      const hint = machines.map((m) => `bash scripts/deploy-node.sh ${m}`).join('\n');
      return html`<span
        class="node-badge stale"
        title="Node not connected — degraded. ${fixHint}
${hint}"
        >NODE DEGRADED</span
      >`;
    }

    // Mixed: show per-machine degraded badges
    return offlineMachines.map((m) => {
      const deployHint = `bash scripts/deploy-node.sh ${m}`;
      return html`<span
        class="node-badge stale"
        title="Node not connected for ${m} — degraded. ${fixHint}
${deployHint}"
        >${m} DEGRADED</span
      >`;
    });
  }

  render() {
    const expandedRun = this.expandedSlotId ? this.slotRuns.get(this.expandedSlotId) : null;
    return html`
      <div class="group">
        <div class="group-header">
          <span class="os-icon">[${this.getOsIcon()}]</span>
          <a class="machine-link" href="#config/${this.machine}">${this.machine}</a>
          ${this.machineHealth
            ? html`<machine-health-bar .health=${this.machineHealth}></machine-health-bar>`
            : this.groupMachines.map((m) => {
                const h = this.machineHealthMap.get(m);
                return h ? html`<machine-health-bar .health=${h}></machine-health-bar>` : nothing;
              })}
          ${this.renderNodeBadge()} ${this.renderProviderAccounts()}
          <span class="slot-count"
            >${this.slots.length} slot${this.slots.length !== 1 ? 's' : ''}</span
          >
        </div>
        ${this.viewMode === 'list' ? this.renderListView() : this.renderCardView()}
        ${expandedRun && this.expandedSlotId
          ? this.renderRunPanel(expandedRun, this.expandedSlotId)
          : nothing}
      </div>
    `;
  }

  private renderCardView() {
    return html`
      <div class="slots-grid">
        ${this.slots.map(
          (s) =>
            html`<slot-card
              .slotData=${s}
              ?nodeOnline=${this.onlineMachines.has(s.machine)}
              .progress=${this.slotProgress.get(s.slot)}
              .linkedRun=${this.slotRuns.get(s.slot)}
              .thumbnailData=${this.slotThumbnails.get(s.slot)}
              .pendingDecisions=${this.slotDecisions.get(s.slot) ?? 0}
              .pendingWork=${this.slotPendingWork.get(s.slot)}
              ?expanded=${this.expandedSlotId === s.slot}
              @slot-expand=${(e: CustomEvent) => this.handleSlotExpand(e.detail.slotId)}
            ></slot-card>`,
        )}
      </div>
    `;
  }

  private renderListView() {
    return html`
      <table class="slot-table">
        <thead>
          <tr>
            <th>Slot</th>
            <th>State</th>
            <th>Flow</th>
            <th>Ticket</th>
            <th>Summary</th>
            <th>Lane</th>
            <th>Identity</th>
            <th>Progress</th>
            <th>Model</th>
            <th>Branch</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${this.slots.map((s) => this.renderListRow(s))}
        </tbody>
      </table>
    `;
  }

  private renderListRow(s: SlotStatus) {
    const run = this.slotRuns.get(s.slot);
    const progress = this.slotProgress.get(s.slot);
    const lc = lifecycleColor(s.lifecycle);
    const pct =
      progress && progress.totalSteps > 0
        ? Math.round((progress.completedSteps / progress.totalSteps) * 100)
        : 0;
    const isExpanded = this.expandedSlotId === s.slot;
    const hasRun = !!run;
    const isWorking = s.lifecycle === 'busy' && s.phase === 'working';
    const branch = slotBranchDisplay(s, getProjectSlotTrackingConfigs());
    const branchLabel = branch.label;
    const branchClass =
      branch.tone === 'baseline'
        ? 'branch-cell main'
        : branch.tone === 'tracking'
          ? 'branch-cell tracking'
          : 'branch-cell stale';

    return html`
      <tr
        class="slot-row ${isExpanded ? 'expanded' : ''} ${isWorking ? 'working' : ''}"
        @click=${() => {
          if (hasRun) {
            this.handleSlotExpand(s.slot);
          } else {
            location.hash = `slot/${s.slot}`;
          }
        }}
      >
        <td>
          <span class="lc-dot" style="background:${lc}"></span
          ><span class="slot-name">${s.slot.replace(`${this.machine}-`, '')}</span>
        </td>
        <td>
          <span class="lc-text" style="color:${lc}">${s.lifecycle}</span>
          ${isWorking
            ? html`<span class="working-spinner" title="Agent actively working"></span>`
            : ''}
        </td>
        <td>
          ${run
            ? html`<span
                class="flow-pill"
                style="background:${flowColor(run.flowType)}22; color:${flowColor(run.flowType)}"
                >${flowLabel(run.flowType)}</span
              >`
            : html`<span class="muted">-</span>`}
        </td>
        <td>${run?.ticketOrPr ?? s.taskId ?? html`<span class="muted">-</span>`}</td>
        <td class="summary-cell">${run?.summary ?? ''}</td>
        <td class="muted">
          ${run?.lane ?? s.currentLane ?? '-'}${run?.variant
            ? `/${run.variant}`
            : s.currentVariant
              ? `/${s.currentVariant}`
              : ''}
        </td>
        <td class="muted">
          ${this.slotPendingWork.get(s.slot)?.queued.length
            ? `${this.slotPendingWork.get(s.slot)?.queued.length} queued`
            : s.currentRunId && !s.currentFamilyId
              ? 'legacy-id'
              : '-'}
        </td>
        <td class="progress-cell">
          ${progress
            ? html`
                <span class="progress-bar"
                  ><span class="progress-fill" style="width:${pct}%"></span
                ></span>
                <span class="muted">${progress.completedSteps}/${progress.totalSteps}</span>
              `
            : html`<span class="muted">-</span>`}
        </td>
        <td class="muted">${s.model ?? run?.metrics?.model ?? '-'}</td>
        <td class="${branchClass}" title="${s.branch}">${branchLabel}</td>
        <td style="white-space:nowrap">
          ${hasRun
            ? html`<button
                class="nav-btn"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  location.hash = `slot/${s.slot}`;
                }}
                title="Open slot view"
              >
                Open
              </button>`
            : ''}
          <button
            class="nav-btn"
            @click=${(e: Event) => {
              e.stopPropagation();
              location.hash = `terminal/${s.slot}`;
            }}
            title="Terminal"
          >
            &gt;_
          </button>
          <button
            class="nav-btn"
            @click=${(e: Event) => {
              e.stopPropagation();
              this.dispatchEvent(
                new CustomEvent('slot-actions-open', {
                  detail: { slotId: s.slot },
                  bubbles: true,
                  composed: true,
                }),
              );
            }}
            title="Slot actions (refresh, recycle, release...)"
          >
            &#x22EF;
          </button>
        </td>
      </tr>
    `;
  }

  private renderRunPanel(run: Run, slotId: string) {
    const fc = flowColor(run.flowType);
    const sc = runStatusColor(run.status);
    const elapsed = run.createdAt ? formatElapsed(run.createdAt) : '';
    const tp = this.slotProgress.get(slotId);
    return html`
      <div class="run-panel">
        <div class="run-panel-header">
          <span class="run-panel-status" style="background:${sc}"></span>
          <span class="run-panel-id">RUN ${run.id.slice(0, 4)}</span>
          <span class="run-panel-flow" style="background:${fc}22; color:${fc}"
            >${flowLabel(run.flowType)}</span
          >
          <span
            class="run-panel-flow"
            style="background:${colors.textMuted}22; color:${colors.textMuted}"
            >${run.lane}</span
          >
          ${run.variant
            ? html`<span
                class="run-panel-flow"
                style="background:${colors.accent}22; color:${colors.accent}"
                >${run.variant}</span
              >`
            : nothing}
          <span
            class="run-panel-flow"
            style="background:${colors.bgCard}22; color:${colors.textMuted}"
            >family:${run.familyId.slice(0, 8)}</span
          >
          ${run.parentRunId
            ? html`<span
                class="run-panel-flow"
                style="background:${colors.bgCard}22; color:${colors.textMuted}"
                >parent:${run.parentRunId.slice(0, 8)}</span
              >`
            : nothing}
          ${run.familyRootTicketOrPr
            ? html`<span class="run-panel-ticket">${run.familyRootTicketOrPr}</span>`
            : nothing}
          ${run.ticketOrPr
            ? html`<span class="run-panel-ticket">${run.ticketOrPr}</span>`
            : nothing}
          ${run.summary
            ? html`<span
                style="color:${colors.textMuted}; font-size:10px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
                >${run.summary}</span
              >`
            : nothing}
          ${elapsed ? html`<span class="run-panel-elapsed">${elapsed}</span>` : nothing}
          <div class="run-panel-nav">
            <button
              class="nav-btn"
              @click=${() => {
                location.hash = `family/${run.familyId}${['done', 'failed', 'cancelled'].includes(run.status) ? `?run=${encodeURIComponent(run.id)}` : ''}`;
              }}
              title="Retrospective"
            >
              Retro
            </button>
            <button
              class="nav-btn"
              @click=${() => {
                location.hash = `slot/${slotId}`;
              }}
              title="Open slot view"
            >
              Open
            </button>
            <button
              class="nav-btn"
              @click=${() => {
                location.hash = `terminal/${slotId}`;
              }}
              title="Open terminal"
            >
              &gt;_
            </button>
            <button
              class="nav-btn"
              @click=${() => {
                location.hash = ['done', 'failed', 'cancelled'].includes(run.status)
                  ? `family/${run.familyId}?run=${encodeURIComponent(run.id)}`
                  : `run/${run.id}`;
              }}
              title=${['done', 'failed', 'cancelled'].includes(run.status)
                ? 'Open retrospective'
                : 'Full run detail'}
            >
              &gt;&gt;
            </button>
          </div>
        </div>
        <run-pipeline .run=${run} .taskProgress=${tp}></run-pipeline>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'machine-group': MachineGroup;
  }
}
