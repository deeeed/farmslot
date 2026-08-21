import { css, html, LitElement, svg, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  ResourcePressureHistoryResult,
  ResourcePressureSnapshotResult,
} from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

import {
  mergePressureHistoryForRender,
  pressureBytes,
  pressureHistoryFreshnessLabel,
  pressureLoadRatio,
  pressureOwnershipLabel,
  pressureProcessCpu,
  pressureProcessName,
  pressureSampleAge,
  pressureSparklinePoints,
  visiblePressureGroups,
} from './machine-pressure-model.js';

@customElement('machine-pressure-overview')
export class MachinePressureOverview extends LitElement {
  @property({ attribute: false }) snapshot?: ResourcePressureSnapshotResult;
  /** Fast history-only read for first paint; the full snapshot replaces it. */
  @property({ attribute: false }) historyPreview?: ResourcePressureHistoryResult;
  @property({ attribute: false }) visibleMachines?: string[];

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
    // Charts-first paint: the lightweight resource.pressure.history read
    // returns immediately (rehydrated rings + freshness) while the full
    // snapshot resolves attribution in the background. This is its own
    // rendering path, never a faked partial snapshot.
    if (!this.snapshot && this.historyPreview) {
      const machines = this.visibleMachines
        ? this.historyPreview.machines.filter((machine) =>
            this.visibleMachines!.includes(machine.machine),
          )
        : this.historyPreview.machines;
      if (machines.length === 0) return html`<div class="empty">Loading pressure history…</div>`;
      return html`<div class="grid">
        ${machines.map((machine) => {
          const cpuValues = machine.history.map((sample) => sample.pressure.cpu);
          const freshness = pressureHistoryFreshnessLabel(machine.historyFreshness);
          return html`<section class="machine ok" data-machine=${machine.machine}>
            <header>
              <div>
                <strong>${machine.machine}</strong>
                <span class="sample-note" data-testid="pressure-history-samples">
                  · ${machine.history.length} samples
                </span>
                ${freshness
                  ? html`<span class="sample-note" data-testid="pressure-history-freshness">
                      · ${freshness}
                    </span>`
                  : ''}
              </div>
            </header>
            <svg class="sparkline" viewBox="0 0 100 24" preserveAspectRatio="none">
              <polyline points=${pressureSparklinePoints(cpuValues, 1)}></polyline>
            </svg>
            <div class="sample-note">attribution and details loading…</div>
          </section>`;
        })}
      </div>`;
    }
    if (!this.snapshot) return html`<div class="empty">Loading pressure history…</div>`;
    // The full snapshot owns attribution and resource details, while the fast
    // history read keeps advancing on node-health events. Merge only the ring
    // and freshness fields so charts do not freeze at snapshot time.
    const snapshotMachines = mergePressureHistoryForRender(
      this.snapshot.machines,
      this.historyPreview?.machines,
    );
    const machines = this.visibleMachines
      ? snapshotMachines.filter((machine) => this.visibleMachines!.includes(machine.machine))
      : snapshotMachines;
    const omitted = this.snapshot.summary;
    if (machines.length === 0)
      return html`<div class="empty">
        No machines match the
        filters.${omitted.omittedMachines > 0
          ? ` ${omitted.omittedMachines} machine(s) were outside the bounded response; select a machine to load it directly.`
          : ''}
      </div>`;
    return html`${omitted.omittedMachines > 0 || omitted.omittedCleanupCandidates > 0
        ? html`<div class="diagnosis">
            Bounded response omitted ${omitted.omittedMachines} machine(s) and
            ${omitted.omittedCleanupCandidates} cleanup candidate(s). Narrow the global selectors to
            inspect them directly.
          </div>`
        : ''}
      <div class="grid">
        ${machines.map((machine) => {
          const latest = machine.history.at(-1);
          const cpuValues = machine.history.map((sample) => sample.pressure.cpu);
          const memoryValues = machine.history.map((sample) => sample.pressure.memory);
          const loadValues = machine.history
            .map((sample) => sample.pressure.load1)
            .filter((value): value is number => value != null);
          const loadMax = Math.max(2, Math.ceil(Math.max(0, ...loadValues)));
          const cores = machine.capacity?.cpuCores ?? machine.system?.cpuCores ?? 0;
          const classes = machine.processAttribution.classCounts;
          const topGroup = machine.processAttribution.groups[0];
          const groups = visiblePressureGroups(machine.processAttribution.groups, 6);
          const processNote = machine.processAttribution.sampledProcesses
            ? `${machine.processAttribution.sampledProcesses}/${machine.processAttribution.totalProcesses} sampled · ${pressureSampleAge(machine.processAttribution.sampledAt)}`
            : (machine.processAttribution.unavailableReason ?? 'awaiting process sample');
          return html`<section class="machine ${machine.severity}" data-machine=${machine.machine}>
            <header>
              <div>
                <strong>${machine.machine}</strong>
                <span class="sample-note" data-testid="pressure-history-samples">
                  · ${machine.history.length} samples
                </span>
                ${pressureHistoryFreshnessLabel(machine.historyFreshness)
                  ? html`<span class="sample-note" data-testid="pressure-history-freshness">
                      · ${pressureHistoryFreshnessLabel(machine.historyFreshness)}
                    </span>`
                  : ''}
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
                  aria-haspopup="dialog"
                  @click=${() => this.openMachine(machine.machine)}
                >
                  Runs & relief
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
                        pressureOwnershipLabel(topGroup.classification)}
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
                value: pressureLoadRatio(latest?.pressure.load1),
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
                    pressureOwnershipLabel(group.classification)}</span
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

  private openMachine(machine: string) {
    this.dispatchEvent(
      new CustomEvent('machine-pressure-open', {
        detail: { machine },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'machine-pressure-overview': MachinePressureOverview;
  }
}
