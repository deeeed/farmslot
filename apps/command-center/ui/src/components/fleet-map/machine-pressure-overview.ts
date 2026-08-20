import { css, html, LitElement, svg, unsafeCSS } from 'lit';
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
  @property({ attribute: false }) visibleMachines?: string[];
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
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: start;
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
    .diagnosis {
      margin-bottom: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-left: 2px solid ${unsafeCSS(colors.statusWarn)};
      border-radius: 3px;
      background: ${unsafeCSS(colors.statusWarn)}0d;
      color: ${unsafeCSS(colors.textSecondary)};
      line-height: 1.5;
    }
    .machine.critical .diagnosis {
      border-left-color: ${unsafeCSS(colors.statusFail)};
      background: ${unsafeCSS(colors.statusFail)}0d;
    }
    .diagnosis strong {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .diagnosis-reason {
      color: ${unsafeCSS(colors.textMuted)};
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
    .group-head {
      color: ${unsafeCSS(colors.textMuted)};
      background: transparent;
      text-transform: uppercase;
      font-size: 8px;
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
    .sampler-error {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .history-panel {
      margin-top: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      background: ${unsafeCSS(colors.bgInput)}66;
    }
    .history-heading,
    .history-labels {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .history-heading {
      color: ${unsafeCSS(colors.textPrimary)};
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .history-series + .history-series {
      margin-top: ${unsafeCSS(spacing.sm)};
    }
    .history-labels {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 9px;
    }
    .history-labels strong {
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: 10px;
    }
    .history-chart {
      display: block;
      width: 100%;
      height: 56px;
      margin-top: 2px;
      border-radius: 4px;
      background: ${unsafeCSS(colors.bgSurface)};
    }
    .history-chart polyline {
      fill: none;
      stroke: ${unsafeCSS(colors.accent)};
      stroke-width: 4;
      vector-effect: non-scaling-stroke;
    }
    .history-chart polygon {
      fill: ${unsafeCSS(colors.accent)}66;
    }
    .history-series.memory .history-chart polyline {
      stroke: ${unsafeCSS(colors.lifecycleManual)};
    }
    .history-series.memory .history-chart polygon {
      fill: ${unsafeCSS(colors.lifecycleManual)}66;
    }
    .history-series.load .history-chart polyline {
      stroke: ${unsafeCSS(colors.statusWarn)};
    }
    .history-series.load .history-chart polygon {
      fill: ${unsafeCSS(colors.statusWarn)}66;
    }
    .history-chart .capacity-line {
      stroke: ${unsafeCSS(colors.statusWarn)}aa;
      stroke-width: 1;
      stroke-dasharray: 3 3;
      vector-effect: non-scaling-stroke;
    }
    @media (max-width: 1800px) {
      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .metrics {
        grid-template-columns: 1fr;
      }
    }
  `;

  render() {
    if (!this.snapshot) return html`<div class="empty">Loading pressure history…</div>`;
    const machines = this.visibleMachines
      ? this.snapshot.machines.filter((machine) => this.visibleMachines!.includes(machine.machine))
      : this.snapshot.machines;
    if (machines.length === 0) return html`<div class="empty">No machines match the filters.</div>`;
    return html`<div class="grid">
      ${machines.map((machine) => {
        const latest = machine.history.at(-1);
        const expanded = this.expandedMachines.has(machine.machine);
        const cpuValues = machine.history.map((sample) => sample.pressure.cpu);
        const memoryValues = machine.history.map((sample) => sample.pressure.memory);
        const loadValues = machine.history
          .map((sample) => sample.pressure.load1)
          .filter((value): value is number => value != null);
        const loadMax = Math.max(2, Math.ceil(Math.max(0, ...loadValues)));
        const cores = machine.capacity?.cpuCores ?? machine.system?.cpuCores ?? 0;
        const classes = machine.processAttribution.classCounts;
        const topGroup = machine.processAttribution.groups[0];
        const groups = visiblePressureGroups(machine.processAttribution.groups, expanded ? 12 : 4);
        const processNote = machine.processAttribution.sampledProcesses
          ? `${machine.processAttribution.sampledProcesses}/${machine.processAttribution.totalProcesses} sampled · ${pressureSampleAge(machine.processAttribution.sampledAt)}`
          : (machine.processAttribution.unavailableReason ?? 'awaiting process sample');
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
                data-testid=${`pressure-details-${machine.machine}`}
                aria-expanded=${expanded}
                @click=${() => this.toggle(machine.machine)}
              >
                ${expanded ? 'Collapse' : 'Details'}
              </button>
            </div>
          </header>
          ${machine.severity !== 'ok'
            ? html`<div class="diagnosis">
                ${topGroup
                  ? html`<div>
                      Top observed tree:
                      <strong>${pressureProcessName(topGroup.topExecutable)}</strong> ·
                      ${pressureProcessCpu(topGroup.cpuPercent)} tree CPU ·
                      ${pressureBytes(topGroup.topRssBytes)} hot RSS ·
                      ${topGroup.slotId?.replace(`${machine.machine}-`, '') ??
                      (topGroup.classification === 'unknown'
                        ? 'system / unmapped'
                        : topGroup.classification)}
                    </div>`
                  : ''}
                ${machine.concerns[0]
                  ? html`<div class="diagnosis-reason">${machine.concerns[0].reason}</div>`
                  : ''}
              </div>`
            : ''}
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
              maxValue: loadMax,
              capacityLine: true,
              tone: 'load',
            })}
          </div>
          ${expanded ? this.renderHistory(machine) : ''}
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
            ${groups.length > 0
              ? html`<div class="group group-head">
                  <span>Owner</span><span>Hot process</span
                  ><span class="process-stat">Tree CPU</span
                  ><span class="process-stat">Hot RSS</span>
                </div>`
              : ''}
            ${groups.map((group) => {
              const hotName = pressureProcessName(group.topExecutable);
              const rootName = pressureProcessName(group.executable);
              const displayName = hotName.length < 8 && rootName !== hotName ? rootName : hotName;
              return html`<div
                class="group"
                title=${`${group.classification}; confidence ${group.confidence}; ${group.evidence.join(', ')}`}
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
              ? html`<span class="sample-note"
                  >${machine.processAttribution.unavailableReason ??
                  'No process attribution available yet.'}</span
                >`
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
        ${areaPoints ? svg`<polygon points=${areaPoints}></polygon>` : ''}
        ${options.capacityLine
          ? svg`<line class="capacity-line" x1="0" y1="12.5" x2="100" y2="12.5"></line>`
          : ''}
        ${points ? svg`<polyline points=${points}></polyline>` : ''}
      </svg>
    </div>`;
  }

  private renderDetails(machine: ResourcePressureSnapshotResult['machines'][number]) {
    const process = machine.processAttribution;
    return html`<div class="detail-note">
      <div>
        ${process.unavailableReason
          ? process.unavailableReason
          : process.sampledProcesses === 0
            ? 'No process inventory received yet.'
            : process.truncated
              ? `Inventory capped at ${process.maxEntries}; hottest processes are retained${process.ancestryTruncated ? ', with some parent chains shortened at the cap' : ' with complete sampled ancestry'}.`
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
            executions · ${process.sampler.skippedCadence} avoided probes ·
            ${process.sampler.failures} failures
          </div>`
        : ''}
      ${process.sampler?.lastError
        ? html`<div class="sampler-error">Sampler error: ${process.sampler.lastError}</div>`
        : ''}
      ${process.degradedReason
        ? html`<div class="sampler-error">${process.degradedReason}</div>`
        : ''}
      ${machine.concerns.map((concern) => html`<div>• ${concern.reason}</div>`)}
    </div>`;
  }

  private renderHistory(machine: ResourcePressureSnapshotResult['machines'][number]) {
    const history = machine.history;
    const firstAt = history[0]?.collectedAt;
    const lastAt = history.at(-1)?.collectedAt;
    const minutes =
      firstAt && lastAt
        ? Math.max(0, Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 60_000))
        : 0;
    const cpu = history.map((sample) => sample.pressure.cpu);
    const memory = history.map((sample) => sample.pressure.memory);
    const load = history
      .map((sample) => sample.pressure.load1)
      .filter((value): value is number => value != null);
    const loadMax = Math.max(2, Math.ceil(Math.max(0, ...load)));
    return html`<div class="history-panel">
      <div class="history-heading">
        <strong>Pressure history</strong>
        <span class="sample-note" data-testid="pressure-history-samples"
          >${history.length} samples · ${minutes} min</span
        >
      </div>
      ${this.renderHistorySeries(
        'CPU utilization',
        cpu,
        1,
        'cpu',
        (value) => `${Math.round(value * 100)}%`,
      )}
      ${this.renderHistorySeries(
        'Memory',
        memory,
        1,
        'memory',
        (value) => `${Math.round(value * 100)}%`,
      )}
      ${this.renderHistorySeries(
        'Load / core',
        load,
        loadMax,
        'load',
        (value) => `${value.toFixed(2)}×`,
        1,
      )}
    </div>`;
  }

  private renderHistorySeries(
    label: string,
    values: number[],
    maxValue: number,
    tone: 'cpu' | 'memory' | 'load',
    format: (value: number) => string,
    capacity?: number,
  ) {
    const points = pressureSparklinePoints(values, maxValue);
    const areaPoints = points ? `0,24 ${points} 100,24` : '';
    const current = values.at(-1);
    const min = values.length > 0 ? Math.min(...values) : undefined;
    const max = values.length > 0 ? Math.max(...values) : undefined;
    const capacityY = capacity == null ? null : 23 - Math.min(1, capacity / maxValue) * 21;
    return html`<div class="history-series ${tone}">
      <div class="history-labels">
        <strong>${label} ${current == null ? '–' : format(current)}</strong>
        <span>${min == null ? '–' : format(min)} min · ${max == null ? '–' : format(max)} max</span>
      </div>
      <svg class="history-chart" viewBox="0 0 100 24" preserveAspectRatio="none">
        ${areaPoints ? svg`<polygon points=${areaPoints}></polygon>` : ''}
        ${capacityY == null
          ? ''
          : svg`<line
              class="capacity-line"
              x1="0"
              y1=${capacityY}
              x2="100"
              y2=${capacityY}
            ></line>`}
        ${points ? svg`<polyline points=${points}></polyline>` : ''}
      </svg>
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
