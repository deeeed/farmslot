import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  MachineHealth,
  NodeInfo,
  Run,
  SlotStatus,
  TaskProgressStructured,
} from '@farmslot/protocol';

import './slot-card.js';
import './machine-health-bar.js';
import '../runs/run-pipeline.js';

import {
  colors,
  fonts,
  lifecycleColor,
  radii,
  shadows,
  spacing,
} from '../../styles/theme-tokens.js';
import { flowColor, flowLabel, formatElapsed, runStatusColor } from '../runs/run-utils.js';

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
  @property({ attribute: false }) nodeInfo?: NodeInfo;
  @property({ attribute: false }) nodeInfoMap: Map<string, NodeInfo> = new Map();
  @property({ attribute: false }) machineHealthMap: Map<string, MachineHealth> = new Map();
  @property() gatewayProtocolVersion = '';
  @property() viewMode: 'card' | 'list' = 'card';
  @state() private expandedSlotId: string | null = null;

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
    .slot-row .branch-cell.main {
      color: ${unsafeCSS(colors.textMuted)};
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

    if (offlineMachines.length === machines.length) {
      // All machines offline
      const hint = machines.map((m) => `bash scripts/deploy-node.sh ${m}`).join('\n');
      return html`<span
        class="node-badge offline"
        title="No node agents connected. Fix:
${hint}"
        >NODE OFFLINE</span
      >`;
    }

    // Mixed: show per-machine offline badges
    return offlineMachines.map((m) => {
      const deployHint = `bash scripts/deploy-node.sh ${m}`;
      return html`<span
        class="node-badge offline"
        title="No node agent connected for ${m}. Fix:
${deployHint}"
        >${m} OFFLINE</span
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
          ${this.renderNodeBadge()}
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
    const branchLabel =
      s.branch === 'main' ? 'main' : s.branch && s.branch !== 'main' ? s.branch : '';
    const branchClass = s.branch === 'main' ? 'branch-cell main' : 'branch-cell';

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
        <td class="muted">${s.currentRunId && !s.currentFamilyId ? 'legacy-id' : '-'}</td>
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
