import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { MachineHealth } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

const HEADROOM_COLORS: Record<string, string> = {
  green: '#00ff88',
  yellow: '#ffcc00',
  red: '#ff4444',
};

@customElement('machine-health-bar')
export class MachineHealthBar extends LitElement {
  @property({ attribute: false }) health?: MachineHealth;

  static styles = css`
    :host {
      display: block;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      padding: 2px 0;
    }
    .meter {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .meter-label {
      width: 24px;
      text-align: right;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .meter-track {
      width: 60px;
      height: 6px;
      background: ${unsafeCSS(colors.bgCardHover)};
      border-radius: 3px;
      overflow: hidden;
    }
    .meter-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.5s ease;
    }
    .meter-pct {
      width: 28px;
      text-align: right;
    }
    .headroom-badge {
      font-size: 9px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .thermal-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}18;
    }
    .offline {
      color: ${unsafeCSS(colors.textMuted)};
      font-style: italic;
    }
  `;

  render() {
    if (!this.health) return nothing;
    const h = this.health;

    if (!h.online) {
      return html`<div class="bar"><span class="offline">offline</span></div>`;
    }

    if (!h.system) {
      return html`<div class="bar"><span class="offline">no metrics</span></div>`;
    }

    const s = h.system;
    const hc = HEADROOM_COLORS[h.headroom] ?? colors.textMuted;

    return html`
      <div class="bar">
        ${this.renderMeter('CPU', s.cpuPercent, hc)} ${this.renderMeter('MEM', s.memoryPercent, hc)}
        ${this.renderMeter('DSK', s.diskPercent, this.diskColor(s.diskPercent))}
        <span class="headroom-badge" style="color:${hc}; background:${hc}18;">${h.headroom}</span>
        ${s.thermalPressure && s.thermalPressure !== 'nominal'
          ? html`<span class="thermal-badge">${s.thermalPressure}</span>`
          : nothing}
      </div>
    `;
  }

  private diskColor(pct: number): string {
    if (pct > 90) return '#ff4444';
    if (pct >= 80) return '#ffcc00';
    return '#00ff88';
  }

  private renderMeter(label: string, pct: number, color: string) {
    return html`
      <span class="meter">
        <span class="meter-label">${label}</span>
        <span class="meter-track">
          <span class="meter-fill" style="width:${pct}%; background:${color};"></span>
        </span>
        <span class="meter-pct">${pct}%</span>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'machine-health-bar': MachineHealthBar;
  }
}
