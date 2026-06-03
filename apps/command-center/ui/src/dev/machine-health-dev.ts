import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement } from 'lit/decorators.js';

import type { MachineHealth } from '@farmslot/protocol';

import '../components/fleet-map/machine-health-bar.js';
import '../components/fleet-map/slot-headroom-dot.js';

import { colors, fonts, spacing } from '../styles/theme-tokens.js';

const MOCK_MACHINES: MachineHealth[] = [
  {
    machine: 'runner-local',
    online: true,
    system: {
      cpuPercent: 78,
      memoryPercent: 52,
      memoryUsedGb: 41.6,
      memoryTotalGb: 80,
      diskPercent: 89,
      loadAvg1: 6.2,
      loadAvg5: 5.8,
      thermalPressure: 'nominal',
      collectedAt: new Date().toISOString(),
    },
    capacity: { maxSlots: 6, activeSlots: 3, cpuCores: 14 },
    headroom: 'yellow',
  },
  {
    machine: 'runner-a',
    online: true,
    system: {
      cpuPercent: 35,
      memoryPercent: 42,
      memoryUsedGb: 52.5,
      memoryTotalGb: 125,
      diskPercent: 34,
      loadAvg1: 8.4,
      loadAvg5: 7.1,
      collectedAt: new Date().toISOString(),
    },
    capacity: { maxSlots: 2, activeSlots: 1, cpuCores: 24 },
    headroom: 'green',
  },
  {
    machine: 'runner-b',
    online: true,
    system: {
      cpuPercent: 94,
      memoryPercent: 91,
      memoryUsedGb: 113.8,
      memoryTotalGb: 125,
      diskPercent: 78,
      loadAvg1: 22.1,
      loadAvg5: 19.3,
      collectedAt: new Date().toISOString(),
    },
    capacity: { maxSlots: 1, activeSlots: 1, cpuCores: 24 },
    headroom: 'red',
  },
];

@customElement('machine-health-dev')
export class MachineHealthDev extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: ${unsafeCSS(spacing.xl)};
      font-family: ${unsafeCSS(fonts.mono)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    h2 {
      font-size: 14px;
      color: ${unsafeCSS(colors.textSecondary)};
      margin: 24px 0 12px;
    }
    .machine-row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 8px 12px;
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .machine-name {
      width: 80px;
      font-weight: 600;
      font-size: 12px;
    }
    .dots {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 8px 12px;
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .dot-label {
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
    }
  `;

  render() {
    return html`
      <h2>Machine Health Bars</h2>
      ${MOCK_MACHINES.map(
        (m) => html`
          <div class="machine-row">
            <span class="machine-name">${m.machine}</span>
            <machine-health-bar .health=${m}></machine-health-bar>
          </div>
        `,
      )}

      <h2>Offline Machine</h2>
      <div class="machine-row">
        <span class="machine-name">vegeta</span>
        <machine-health-bar
          .health=${{ machine: 'vegeta', online: false, headroom: 'red' } as MachineHealth}
        ></machine-health-bar>
      </div>

      <h2>Headroom Dots</h2>
      <div class="dots">
        <span class="dot-label">green</span>
        <slot-headroom-dot headroom="green"></slot-headroom-dot>
        <span class="dot-label">yellow</span>
        <slot-headroom-dot headroom="yellow"></slot-headroom-dot>
        <span class="dot-label">red</span>
        <slot-headroom-dot headroom="red"></slot-headroom-dot>
        <span class="dot-label">none</span>
        <slot-headroom-dot></slot-headroom-dot>
      </div>
    `;
  }
}
