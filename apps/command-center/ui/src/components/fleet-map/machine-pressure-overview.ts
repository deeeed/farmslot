import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ResourcePressureSnapshotResult } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

import {
  pressureBytes,
  pressureProcessCpu,
  pressureProcessName,
  pressureSampleAge,
  pressureSparklinePoints,
  visiblePressureGroups,
} from './machine-pressure-model.js';

@customElement('machine-pressure-overview')
export class MachinePressureOverview extends LitElement {
  @property({ attribute: false }) snapshot?: ResourcePressureSnapshotResult;
  @state() private expandedMachines: Set<string> = new Set();

  static styles = css`
    :host {
      display: block;
    }
    .empty {
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeMd)};
      text-align: center;
      padding: ${unsafeCSS(spacing.xxxl)};
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
      gap: ${unsafeCSS(spacing.md)};
    }
    .machine {
      padding: ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 8px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .machine.critical {
      border-color: ${unsafeCSS(colors.statusFail)}88;
    }
    .machine.warn {
      border-color: ${unsafeCSS(colors.statusWarn)}55;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: ${unsafeCSS(colors.textPrimary)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    header strong {
      font-size: ${unsafeCSS(fonts.sizeMd)};
    }
    .heading-actions {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .expand {
      padding: 2px 7px;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 4px;
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
      cursor: pointer;
    }
    .expand:hover {
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    .severity {
      border-radius: 999px;
      padding: 2px 7px;
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 0.5px;
      background: ${unsafeCSS(colors.bgCard)};
    }
    .severity.critical {
      color: ${unsafeCSS(colors.statusFail)};
      background: ${unsafeCSS(colors.statusFail)}14;
    }
    .severity.warn {
      color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}14;
    }
    .severity.ok {
      color: ${unsafeCSS(colors.statusOk)};
      background: ${unsafeCSS(colors.statusOk)}14;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: ${unsafeCSS(spacing.sm)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .metric {
      min-width: 0;
      padding: ${unsafeCSS(spacing.sm)};
      border-radius: 6px;
      background: ${unsafeCSS(colors.bgInput)};
    }
    .metric-label {
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-size: 9px;
    }
    .metric-value {
      display: block;
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeMd)};
      margin-top: 2px;
    }
    .metric.cpu .metric-value {
      color: ${unsafeCSS(colors.accent)};
    }
    .metric.memory .metric-value {
      color: ${unsafeCSS(colors.lifecycleManual)};
    }
    .metric.load .metric-value {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .metric-detail {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 9px;
    }
    .sparkline {
      width: 100%;
      height: 30px;
      margin-top: 3px;
      overflow: visible;
    }
    .sparkline polyline {
      fill: none;
      stroke: ${unsafeCSS(colors.accent)};
      stroke-width: 2.5;
      vector-effect: non-scaling-stroke;
    }
    .sparkline polygon {
      fill: ${unsafeCSS(colors.accent)}44;
    }
    .metric.memory .sparkline polyline {
      stroke: ${unsafeCSS(colors.lifecycleManual)};
    }
    .metric.memory .sparkline polygon {
      fill: ${unsafeCSS(colors.lifecycleManual)}44;
    }
    .metric.load .sparkline polyline {
      stroke: ${unsafeCSS(colors.statusWarn)};
    }
    .metric.load .sparkline polygon {
      fill: ${unsafeCSS(colors.statusWarn)}44;
    }
    .sparkline .capacity-line {
      stroke: ${unsafeCSS(colors.statusWarn)}88;
      stroke-width: 1;
      stroke-dasharray: 3 3;
      vector-effect: non-scaling-stroke;
    }
    .classes {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .class-pill {
      padding: 2px 6px;
      border-radius: 999px;
      color: ${unsafeCSS(colors.textMuted)};
      background: ${unsafeCSS(colors.bgInput)};
    }
    .class-pill.active,
    .owner.active {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .class-pill.stale,
    .owner.stale {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .class-pill.manual,
    .owner.manual {
      color: ${unsafeCSS(colors.accent)};
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-size: 9px;
      margin-bottom: 5px;
    }
    .groups {
      display: grid;
      gap: 3px;
    }
    .group {
      display: grid;
      grid-template-columns: 62px minmax(0, 1fr) 64px 58px;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      min-width: 0;
      padding: 3px 5px;
      border-radius: 4px;
      background: ${unsafeCSS(colors.bgInput)}88;
    }
    .owner,
    .process-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .owner,
    .sample-note {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .process-name {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .process-stat {
      text-align: right;
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .sample-note {
      font-size: 9px;
    }
    .detail-note {
      margin-top: ${unsafeCSS(spacing.sm)};
      padding-top: ${unsafeCSS(spacing.sm)};
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textMuted)};
      line-height: 1.5;
    }
    @media (max-width: 700px) {
      .grid,
      .metrics {
        grid-template-columns: 1fr;
      }
    }
  `;

  render() {
    if (!this.snapshot) return html`<div class="empty">Loading pressure history…</div>`;
    return html`<div class="grid">
      ${this.snapshot.machines.map((machine) => {
        const latest = machine.history.at(-1);
        const expanded = this.expandedMachines.has(machine.machine);
        const cpuValues = machine.history.map((sample) => sample.pressure.cpu);
        const memoryValues = machine.history.map((sample) => sample.pressure.memory);
        const loadValues = machine.history
          .map((sample) => sample.pressure.load1)
          .filter((value): value is number => value != null);
        const cores = machine.capacity?.cpuCores ?? machine.system?.cpuCores ?? 0;
        const classes = machine.processAttribution.classCounts;
        const groups = visiblePressureGroups(machine.processAttribution.groups, expanded ? 12 : 4);
        const processNote = machine.processAttribution.sampledProcesses
          ? `${machine.processAttribution.sampledProcesses}/${machine.processAttribution.totalProcesses} sampled · ${pressureSampleAge(machine.processAttribution.sampledAt)}`
          : 'awaiting process sample';
        return html`<section class="machine ${machine.severity}" data-machine=${machine.machine}>
          <header>
            <div>
              <strong>${machine.machine}</strong>
              <span class="sample-note"> · ${machine.history.length} samples</span>
            </div>
            <div class="heading-actions">
              <span
                class="severity ${machine.severity}"
                title=${machine.concerns.map((concern) => concern.reason).join('\n')}
                >${machine.severity}</span
              >
              <button
                class="expand"
                aria-expanded=${expanded}
                @click=${() => this.toggle(machine.machine)}
              >
                ${expanded ? 'Collapse' : 'Details'}
              </button>
            </div>
          </header>
          <div class="metrics">
            ${this.renderMetric({
              label: 'CPU',
              value: latest ? `${Math.round(latest.pressure.cpu * 100)}%` : '–',
              detail: cores > 0 ? `${cores} logical cores` : 'whole machine',
              values: cpuValues,
              maxValue: 1,
              tone: 'cpu',
            })}
            ${this.renderMetric({
              label: 'Memory',
              value: latest ? `${Math.round(latest.pressure.memory * 100)}%` : '–',
              detail: machine.system
                ? `${machine.system.memoryUsedGb}/${machine.system.memoryTotalGb} GB used`
                : 'awaiting metrics',
              values: memoryValues,
              maxValue: 1,
              tone: 'memory',
            })}
            ${this.renderMetric({
              label: 'Load / core',
              value: latest?.pressure.load1 == null ? '–' : `${latest.pressure.load1.toFixed(2)}×`,
              detail:
                latest && cores > 0
                  ? `${latest.loadAvg1.toFixed(1)} load / ${cores} cores`
                  : 'needs core count',
              values: loadValues,
              maxValue: 2,
              capacityLine: true,
              tone: 'load',
            })}
          </div>
          <div class="classes">
            <span class="class-pill active">active ${classes.active}</span>
            <span class="class-pill retained">retained ${classes.retained}</span>
            <span class="class-pill stale">stale ${classes.stale}</span>
            <span class="class-pill manual">manual ${classes.manual}</span>
            <span class="class-pill unknown">system / unmapped ${classes.unknown}</span>
          </div>
          <div class="section-title">
            <span>Top processes + managed work</span>
            <span class="sample-note">${processNote}</span>
          </div>
          <div class="groups">
            ${groups.map((group) => {
              const hotName = pressureProcessName(group.topExecutable);
              const rootName = pressureProcessName(group.executable);
              const displayName = hotName.length < 8 && rootName !== hotName ? rootName : hotName;
              return html`<div
                class="group"
                title=${`${group.evidence.join(', ')}; hot pid ${group.topPid}; root ${group.rootPid}:${group.executable}; confidence ${group.confidence}`}
              >
                <span class="owner ${group.classification}"
                  >${group.slotId?.replace(`${machine.machine}-`, '') ??
                  (group.classification === 'unknown' ? 'system' : group.classification)}</span
                >
                <span class="process-name">${displayName}</span>
                <span class="process-stat">${pressureProcessCpu(group.cpuPercent)}</span>
                <span class="process-stat">${pressureBytes(group.topRssBytes)}</span>
              </div>`;
            })}
            ${groups.length === 0
              ? html`<span class="sample-note">No process attribution available yet.</span>`
              : ''}
          </div>
          ${expanded ? this.renderDetails(machine) : ''}
        </section>`;
      })}
    </div>`;
  }

  private renderMetric(options: {
    label: string;
    value: string;
    detail: string;
    values: number[];
    maxValue: number;
    capacityLine?: boolean;
    tone: 'cpu' | 'memory' | 'load';
  }) {
    const points = pressureSparklinePoints(options.values, options.maxValue);
    const areaPoints = points ? `0,24 ${points} 100,24` : '';
    return html`<div class="metric ${options.tone}">
      <span class="metric-label">${options.label}</span>
      <span class="metric-value">${options.value}</span>
      <span class="metric-detail" title=${options.detail}>${options.detail}</span>
      <svg class="sparkline" viewBox="0 0 100 24" preserveAspectRatio="none">
        ${areaPoints ? html`<polygon points=${areaPoints}></polygon>` : ''}
        ${options.capacityLine
          ? html`<line class="capacity-line" x1="0" y1="12.5" x2="100" y2="12.5"></line>`
          : ''}
        ${points ? html`<polyline points=${points}></polyline>` : ''}
      </svg>
    </div>`;
  }

  private renderDetails(machine: ResourcePressureSnapshotResult['machines'][number]) {
    const process = machine.processAttribution;
    return html`<div class="detail-note">
      <div>
        ${process.sampledProcesses === 0
          ? 'No process inventory received yet.'
          : process.truncated
            ? `Inventory capped at ${process.maxEntries}; hottest processes and complete sampled ancestry are retained.`
            : 'Complete process inventory retained for this sample.'}
        ${process.omittedGroups > 0
          ? ` ${process.omittedGroups} lower-pressure groups omitted.`
          : ''}
      </div>
      <div>
        System / unmapped means no verified Farmslot run, slot tmux pane, or active resource PID
        owns that tree. It is never cleanup-eligible.
      </div>
      ${process.sampler
        ? html`<div>
            Sampler ${process.sampler.lastDurationMs ?? '–'}ms · ${process.sampler.executions}
            executions · ${process.sampler.skippedCadence} cadence skips ·
            ${process.sampler.failures} failures
          </div>`
        : ''}
      ${machine.concerns.map((concern) => html`<div>• ${concern.reason}</div>`)}
    </div>`;
  }

  private toggle(machine: string) {
    const next = new Set(this.expandedMachines);
    if (next.has(machine)) next.delete(machine);
    else next.add(machine);
    this.expandedMachines = next;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'machine-pressure-overview': MachinePressureOverview;
  }
}
